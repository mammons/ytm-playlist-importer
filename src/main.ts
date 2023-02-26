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

/**
 * It reads the client_secret.json file, then calls the authorize function with the contents of the
 * file and the addPlaylist function
 * @returns the playlist ID.
 */
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
      console.log('Parsing token from disk');
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

/**
 * It takes a TrackData object and returns a string
 * @param {TrackData} data - TrackData - this is the data that we're going to be storing in Redis.
 * @returns A string
 */
function createRedisKey(data: TrackData) {
  return `youtube-data-for-${data['Artist Name(s)']}-${data['Track Name']}`;
}

/**
 * It checks if a video is already in a playlist
 * @param {GoogleAuth} auth - GoogleAuth - this is the authentication object that we created earlier.
 * @param {string} videoId - The ID of the video to add to the playlist.
 * @param {string} playlistId - The ID of the playlist to add the video to.
 * @returns A boolean value.
 */
async function videoIsAlreadyInPlaylist(
  auth: GoogleAuth,
  videoId: string,
  playlistId: string
) {
  const service = google.youtube('v3');

  console.log('Checking if video is unique');

  const videoInPlaylist = await service.playlistItems.list({
    auth,
    part: ['contentDetails'],
    maxResults: 50,
    playlistId,
    videoId,
  });

  return !!videoInPlaylist.data.items.length;
}

/**
 * It takes a track's data, searches for it on YouTube, and adds it to a playlist
 * @param {GoogleAuth} auth - GoogleAuth - this is the authentication object that we created earlier.
 * @param {TrackData} data - The data for the track we're adding to the playlist.
 * @param {string} playlistId - The ID of the playlist you want to add the track to.
 * @returns A promise that resolves to a youtube_v3.Schema[]
 */
async function addTrack(auth: GoogleAuth, data: TrackData, playlistId: string) {
  const service = google.youtube('v3');
  const query = `${data['Artist Name(s)']} ${data['Track Name']}`;
  console.log(`Adding track ${data['Track Name']} to playlist`);

  let youtubeTrackData: youtube_v3.Schema$SearchResult[] =
    await getYoutubeTrackData(auth, data, query);
  const resourceId = youtubeTrackData[0].id;

  if (await videoIsAlreadyInPlaylist(auth, resourceId.videoId, playlistId)) {
    console.log('Video already in playlist', {
      video: youtubeTrackData[0].snippet.title,
      id: resourceId.videoId,
      playlistId,
    });

    return;
  }

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

/**
 * It takes a GoogleAuth object, a TrackData object, and a query string, and returns an array of
 * YouTube search results
 * @param {GoogleAuth} auth - GoogleAuth - This is the authentication object that we created earlier.
 * @param {TrackData} data - TrackData - this is the data that we're going to use to create the Redis
 * key.
 * @param {string} query - The query to search for on YouTube.
 * @returns An array of youtube_v3.Schema
 */
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

/**
 * It checks if a playlist with the given title already exists, and if it does, it returns the id of
 * the playlist
 * @param {GoogleAuth} auth - GoogleAuth - this is the authentication object that we created earlier.
 * @param {string} title - The title of the playlist to create.
 * @returns An object with two properties: exists and id.
 */
async function playlistAlreadyExists(auth: GoogleAuth, title: string) {
  const service = google.youtube('v3');
  const existingPlaylists = await service.playlists.list({
    auth,
    part: ['snippet'],
    maxResults: 20,
    mine: true,
  });

  for (const pl of existingPlaylists.data.items) {
    if (pl.snippet.title === title) {
      return { exists: true, id: pl.id };
    }
  }
  return { exists: false, id: null };
}

/**
 * It takes an auth object, gets a CSV file, checks if a playlist with the same name already exists,
 * creates a playlist if it doesn't, and then adds each track to the playlist
 * @param {GoogleAuth} auth - GoogleAuth - this is the authentication object that we created earlier.
 */
async function addPlaylist(auth: GoogleAuth) {
  const { results, filename } = await getCsvFile<TrackData>();
  const service = google.youtube('v3');

  const { exists, id: existingId } = await playlistAlreadyExists(
    auth,
    filename
  );
  let resolvedId = existingId;
  if (!exists) {
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

      resolvedId = id;
      console.log(`Created playlist ${filename} with id ${id}`);
    } catch (error) {
      console.error('Error inserting playlist', error);
    }
  }
  for (const track of results.data) {
    if (track) {
      await addTrack(auth, track, resolvedId);
    }
  }

  addPlaylist(auth);
}

/**
 * It creates a server that listens for a request from the Google OAuth server, and then calls the
 * callback function with the authorization code
 * @param {Function} callback - This is the function that will be called when the user has authorized
 * your app.
 */
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
    console.log(`Auth server listening on port ${port}`);
  });
}

(async () => {
  await init();
})();
