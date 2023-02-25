import * as fs from 'fs';
import express from 'express';
import url from 'url';

import { google } from 'googleapis';
import { GcpClientSecret } from './types/gcp-client-secret';
import { isArray, isNil } from 'lodash';
import { OAuth2Client, GoogleAuth, Credentials } from 'google-auth-library';

const OAuth2 = google.auth.OAuth2;

const SCOPES = ['https://www.googleapis.com/auth/youtube'];
const TOKEN_DIR = '../.credentials';
const TOKEN_PATH = TOKEN_DIR + 'ytm-playlist-importer.json';

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
    if (err) {
      getNewToken(oauth2Client, callback);
    } else {
      console.log('TOKEN?', token);
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
      if (!isNil(err)) {
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
    fs.mkdirSync(TOKEN_DIR);
  } catch (err) {
    if (err.code != 'EEXIST') {
      throw err;
    }
  }
  fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
    if (err) throw err;
    console.log('Token stored to ' + TOKEN_PATH);
  });
}

async function addPlaylist(auth: GoogleAuth, title: string) {
  var service = google.youtube('v3');
  console.log(`Adding to playlist with ${auth}`);
  try {
    await service.playlistItems.insert({
      requestBody: {
        kind: 'youtube#playlist',
        snippet: {
          title,
        },
      },
    });
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
