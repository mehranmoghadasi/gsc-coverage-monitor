/**
 * auth.js — Google API authentication helper
 *
 * Supports two authentication strategies:
 *   1. Service Account JSON key file (recommended for CI/automated polling)
 *   2. OAuth2 with saved refresh token (for personal use)
 *
 * The strategy is chosen based on the key file's `type` field.
 */

import { google } from 'googleapis';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

/** Required OAuth scopes for Search Console read access */
const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
];

/**
 * Build and return an authenticated Google API auth client.
 *
 * @param {string} keyFilePath - Absolute or relative path to the credentials JSON
 * @returns {Promise<import('googleauth').GoogleAuth>}
 */
export async function createAuthClient(keyFilePath) {
  const resolved = resolve(keyFilePath);

  if (!existsSync(resolved)) {
    throw new Error(
      `Credentials file not found: ${resolved}\n` +
      'Download a service account key from https://console.cloud.google.com/iam-admin/serviceaccounts'
    );
  }

  let keyData;
  try {
    keyData = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse credentials file: ${err.message}`);
  }

  if (keyData.type === 'service_account') {
    return createServiceAccountClient(keyData);
  }

  if (keyData.type === 'authorized_user') {
    return createOAuthClient(keyData);
  }

  throw new Error(
    `Unknown credentials type "${keyData.type}". Expected "service_account" or "authorized_user".`
  );
}

/**
 * Create a GoogleAuth client using a service account.
 *
 * @param {object} keyData
 * @returns {import('googleauth').GoogleAuth}
 */
function createServiceAccountClient(keyData) {
  return new google.auth.GoogleAuth({
    credentials: keyData,
    scopes: SCOPES,
  });
}

/**
 * Create a GoogleAuth client using saved OAuth2 credentials
 * (e.g. from `gcloud auth application-default login`).
 *
 * @param {object} keyData
 * @returns {import('googleauth').GoogleAuth}
 */
function createOAuthClient(keyData) {
  const client = new google.auth.OAuth2(
    keyData.client_id,
    keyData.client_secret,
  );
  client.setCredentials({
    refresh_token: keyData.refresh_token,
  });
  return client;
}

/**
 * Verify the auth client can reach the Search Console API.
 * Throws if authentication fails.
 *
 * @param {import('googleauth').GoogleAuth} auth
 * @returns {Promise<void>}
 */
export async function verifyAuth(auth) {
  const sc = google.webmasters({ version: 'v3', auth });
  try {
    await sc.sites.list();
  } catch (err) {
    if (err.code === 401 || err.code === 403) {
      throw new Error(
        `Google authentication failed (${err.code}): ${err.message}\n` +
        'Ensure the service account has been added to each GSC property as a verified owner or restricted user.'
      );
    }
    // Network errors on verify are non-fatal — surface as warning
    throw new Error(`Auth verification network error: ${err.message}`);
  }
}
