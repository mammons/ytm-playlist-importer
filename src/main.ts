import * as fs from 'fs';
import express from 'express';
import url from 'url';

import { google } from 'googleapis';
import { GcpClientSecret } from './types/gcp-client-secret';
import { isArray } from 'lodash';
import { OAuth2Client, GoogleAuth, Credentials } from 'google-auth-library';
import { getCsvFile } from './utils';
import { TrackData } from './types/track-data';
import { createClient } from 'redis';
import { youtube_v3 } from '@googleapis/youtube';
import { join } from 'path';

const OAuth2 = google.auth.OAuth2;

const SCOPES = ['https://www.googleapis.com/auth/youtube'];
const TOKEN_DIR = join(__dirname, '..', '.credentials');
const TOKEN_PATH = join(TOKEN_DIR, 'ytm-playlist-importer.json');

const client = createClient();
client.on('error', (err) => console.log('Redis Client Error', err));

async function init() {
  // Load client secrets from a local file.
  fs.readFile(
    'client_secret.json',
    'utf-8',
    function processClientSecrets(err, content) {
      if (err) {
        console.log('Error loading client secret file: ' + err);
        return;
      }

      // Authorize a client with the loaded credentials, then call the YouTube API.
      authorize(JSON.parse(content), addPlaylist);
    }
  );

  await client.connect();
}

/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 *
 * @param {Object} credentials The authorization client credentials.
 * @param {function} callback The callback to call with the authorized client.
 */
function authorize(credentials: GcpClientSecret, callback: Function) {
  const clientSecret = credentials.web.client_secret;
  const clientId = credentials.web.client_id;
  const redirectUrl = isArray(credentials.web.redirect_uris)
    ? credentials.web.redirect_uris[0]
    : null;
  const oauth2Client = new OAuth2(clientId, clientSecret, redirectUrl);

  // Check if we have previously stored a token.
  fs.readFile(TOKEN_PATH, 'utf-8', function (err, token) {
    if (err || !token) {
      console.log('Getting new token');
      getNewToken(oauth2Client, callback);
    } else {
      console.log('Parsing token from disc', token);
      oauth2Client.credentials = JSON.parse(token);
      callback(oauth2Client);
    }
  });
}

/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 *
 * @param {google.auth.OAuth2} oauth2Client The OAuth2 client to get token for.
 * @param {getEventsCallback} callback The callback to call with the authorized
 *     client.
 */
function getNewToken(oauth2Client: OAuth2Client, callback: Function) {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('Authorize this app by visiting this url: ', authUrl);

  createServer((code: string) =>
    oauth2Client.getToken(code, (err, token) => {
      if (err) {
        console.log('Error while trying to retrieve access token', err);
        return;
      }
      oauth2Client.credentials = token;
      storeToken(token);
      callback(oauth2Client);
    })
  );
}

/**
 * Store token to disk be used in later program executions.
 *
 * @param {Object} token The token to store to disk.
 */
function storeToken(token: Credentials) {
  try {
    console.log(`Creating token dir ${TOKEN_DIR}`);
    fs.mkdirSync(TOKEN_DIR);
  } catch (err) {
    if (err.code != 'EEXIST') {
      throw err;
    }
  }

  console.log('Persisting token');
  fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
    if (err) throw err;
    console.log('Token stored to ' + TOKEN_PATH);
  });
}

function createRedisKey(data: TrackData) {
  return `youtube-data-for-${data['Artist Name(s)']}-${data['Track Name']}`;
}

async function addTrack(auth: GoogleAuth, data: TrackData, playlistId: string) {
  const service = google.youtube('v3');
  const query = `${data['Artist Name(s)']} ${data['Track Name']}`;
  console.log(`Adding track ${data['Track Name']} to playlist`);

  let youtubeTrackData: youtube_v3.Schema$SearchResult[] =
    await getYoutubeTrackData(auth, data, query);
  const resourceId = youtubeTrackData[0].id;

  try {
    await service.playlistItems.insert({
      auth,
      part: ['snippet'],
      requestBody: {
        snippet: {
          playlistId,
          resourceId,
        },
      },
    });
    console.log(`Added track ${data['Track Name']} to playlist`);
  } catch (error) {
    console.error('Error adding track to playlist', error);
  }
}

async function getYoutubeTrackData(
  auth: GoogleAuth,
  data: TrackData,
  query: string
) {
  const service = google.youtube('v3');
  let youtubeTrackData: youtube_v3.Schema$SearchResult[];
  const cacheData = await client.get(createRedisKey(data));
  if (cacheData) {
    console.log('Using cached track data');
    youtubeTrackData = JSON.parse(cacheData);
  } else {
    console.log('Getting fresh track data from YouTube');
    const searchResults = await service.search.list({
      auth,
      part: ['snippet'],
      q: query,
      maxResults: 1,
    });
    youtubeTrackData = searchResults.data.items;
  }
  if (!isArray(youtubeTrackData)) {
    throw new Error(`No items were returned for query: ${query}`);
  }
  await client.set(createRedisKey(data), JSON.stringify(youtubeTrackData));
  await client.expire(createRedisKey(data), 86400);
  return youtubeTrackData;
}

async function addPlaylist(auth: GoogleAuth) {
  const { results, filename } = await getCsvFile<TrackData>();
  const service = google.youtube('v3');
  try {
    const {
      data: { id },
    } = await service.playlists.insert({
      part: ['snippet'],
      auth,
      requestBody: {
        kind: 'youtube#playlist',
        snippet: {
          title: filename,
        },
      },
    });

    console.log(`Created playlist ${filename} with id ${id}`);

    console.log;
    for (const track of results.data) {
      await addTrack(auth, track, id);
    }
  } catch (error) {
    console.error('Error inserting playlist', error);
  }
}

function createServer(callback: Function) {
  const app = express();
  app.get('/', (req, res) => {
    let q = url.parse(req.url, true).query;

    if (q.error) {
      // An error response e.g. error=access_denied
      console.log('Error:' + q.error);
    } else {
      // Get access and refresh tokens (if access_type is offline)
      callback(q.code);
      res.send();
    }
  });

  const port = 8080;
  app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
  });
}

(async () => {
  await init();
})();
