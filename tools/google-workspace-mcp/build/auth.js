import { google } from 'googleapis';
import fs from 'fs/promises';
import path from 'path';
import { createServer } from 'http';
import crypto from 'crypto';
import open from 'open';
import os from 'os';
const SCOPES = [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/presentations',
    'https://www.googleapis.com/auth/contacts',
];
const REDIRECT_PORT = 4100;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
function authDir() {
    return process.env.GOOGLE_WORKSPACE_MCP_AUTH_DIR || path.join(os.homedir(), '.google-workspace-mcp');
}
// Store tokens in the auth dir (overridable for tests/isolated instances)
const getTokenPath = () => path.join(authDir(), 'token.json');
const getCredentialsPath = () => path.join(authDir(), 'credentials.json');
async function authenticateWithDeviceCode(credentials, oauth2Client) {
    const creds = getOAuthClientConfig(credentials);
    const deviceCodeParams = new URLSearchParams({
        client_id: creds.client_id,
        scope: SCOPES.join(' '),
    });
    const deviceCodeResp = await fetch('https://oauth2.googleapis.com/device/code', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: deviceCodeParams.toString(),
    });
    if (!deviceCodeResp.ok) {
        const errorText = await deviceCodeResp.text();
        throw new Error(`Failed to start device auth flow: ${errorText}`);
    }
    const deviceCodeData = await deviceCodeResp.json();
    const verificationUrl = deviceCodeData.verification_uri_complete
        || deviceCodeData.verification_url
        || deviceCodeData.verification_uri
        || 'https://www.google.com/device';
    const intervalSeconds = deviceCodeData.interval ?? 5;
    const expiresAt = Date.now() + (deviceCodeData.expires_in * 1000);
    console.error('\n=== Google Workspace Device Authentication ===');
    console.error('Open this URL in any browser and complete sign-in:');
    console.error(verificationUrl);
    console.error(`If prompted, enter code: ${deviceCodeData.user_code}`);
    console.error('Waiting for authorization...');
    while (Date.now() < expiresAt) {
        await sleep(intervalSeconds * 1000);
        const tokenParams = new URLSearchParams({
            client_id: creds.client_id,
            client_secret: creds.client_secret,
            device_code: deviceCodeData.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        });
        const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: tokenParams.toString(),
        });
        const tokenJson = await tokenResp.json();
        if (tokenResp.ok && tokenJson.access_token) {
            const tokens = {
                access_token: tokenJson.access_token,
                refresh_token: tokenJson.refresh_token,
                scope: tokenJson.scope,
                token_type: tokenJson.token_type,
                expiry_date: tokenJson.expires_in ? Date.now() + (tokenJson.expires_in * 1000) : undefined,
            };
            oauth2Client.setCredentials(tokens);
            await saveToken(tokens);
            return;
        }
        if (!tokenJson.error || tokenJson.error === 'authorization_pending') {
            continue;
        }
        if (tokenJson.error === 'slow_down') {
            await sleep(intervalSeconds * 1000);
            continue;
        }
        throw new Error(tokenJson.error_description || tokenJson.error || 'Device authentication failed');
    }
    throw new Error('Device authentication timed out');
}
async function ensureConfigDir() {
    const configDir = authDir();
    try {
        await fs.mkdir(configDir, { recursive: true });
    }
    catch (error) {
        // Ignore if directory already exists
    }
}
async function loadCredentials() {
    try {
        const credPath = getCredentialsPath();
        const content = await fs.readFile(credPath, 'utf-8');
        return JSON.parse(content);
    }
    catch (error) {
        return null;
    }
}
async function saveToken(token) {
    await ensureConfigDir();
    const tokenPath = getTokenPath();
    await fs.writeFile(tokenPath, JSON.stringify(token, null, 2));
}
async function loadToken() {
    try {
        const tokenPath = getTokenPath();
        const content = await fs.readFile(tokenPath, 'utf-8');
        return JSON.parse(content);
    }
    catch (error) {
        return null;
    }
}
function createOAuth2Client(credentials) {
    const creds = getOAuthClientConfig(credentials);
    if (!creds) {
        throw new Error('Invalid credentials format');
    }
    return new google.auth.OAuth2(creds.client_id, creds.client_secret, REDIRECT_URI);
}
function getOAuthClientConfig(credentials) {
    const creds = credentials.installed || credentials.web;
    if (!creds) {
        throw new Error('Invalid credentials format');
    }
    return creds;
}
async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function authenticateWithBrowser(oauth2Client) {
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent', // Force consent to get refresh token
    });
    console.error('Opening browser for authentication...');
    console.error(`If browser doesn't open, visit: ${authUrl}`);
    return new Promise((resolve, reject) => {
        const server = createServer(async (req, res) => {
            try {
                if (req.url?.startsWith('/callback')) {
                    const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
                    const code = url.searchParams.get('code');
                    if (!code) {
                        res.writeHead(400, { 'Content-Type': 'text/html' });
                        res.end('<h1>Authentication failed - no code received</h1>');
                        reject(new Error('No authorization code received'));
                        return;
                    }
                    const { tokens } = await oauth2Client.getToken(code);
                    oauth2Client.setCredentials(tokens);
                    await saveToken(tokens);
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end('<h1>Authentication successful!</h1><p>You can close this window.</p>');
                    server.close();
                    resolve();
                }
            }
            catch (error) {
                res.writeHead(500, { 'Content-Type': 'text/html' });
                res.end('<h1>Authentication error</h1>');
                server.close();
                reject(error);
            }
        });
        server.listen(REDIRECT_PORT, () => {
            open(authUrl);
        });
        // Timeout after 5 minutes
        setTimeout(() => {
            server.close();
            reject(new Error('Authentication timeout'));
        }, 5 * 60 * 1000);
    });
}
// Auth status + consent link for the `auth_link` tool. Runs the same recovery
// path as a failing tool call (code exchange, token reload) but never throws:
// the caller decides how to present it. link is a Google consent URL that the
// model should render as a clickable markdown link in its chat reply.
export async function getAuthStatus() {
    const credentials = await loadCredentials();
    if (!credentials) return { status: 'no_credentials' };
    const base = await getPublicBaseUrl();
    if (!base) return { status: 'unconfigured' };
    const link = await tryLinkAuth(credentials);
    if (link.client) return { status: 'ok' };
    if (link.authUrl) return { status: 'reauth_required', link: link.authUrl };
    return { status: 'unconfigured' };
}
export async function getAuthenticatedClient() {
    // First, check if we have credentials file
    let credentials = await loadCredentials();
    if (!credentials) {
        // Try to create default credentials file
        await ensureConfigDir();
        const credPath = getCredentialsPath();
        console.error('\n=== Google Workspace MCP Setup ===');
        console.error(`\nNo credentials found at: ${credPath}`);
        console.error('\nTo set up authentication:');
        console.error('1. Go to https://console.cloud.google.com/');
        console.error('2. Create a project (or select existing)');
        console.error('3. Enable Gmail, Calendar, and Drive APIs');
        console.error('4. Create OAuth 2.0 credentials (Desktop app type)');
        console.error('5. Download the JSON and save it as:');
        console.error(`   ${credPath}`);
        console.error('\nThen run this command again.');
        throw new Error('Credentials file not found. Please set up OAuth credentials first.');
    }
    const oauth2Client = createOAuth2Client(credentials);
    // Try to load existing token
    const token = await loadToken();
    if (token) {
        oauth2Client.setCredentials(token);
        if (await tryRefreshToken(oauth2Client)) return oauth2Client;
        console.error('Token refresh failed, re-authenticating...');
    }
    // No valid token, need to authenticate
    const authFlow = (process.env.GOOGLE_WORKSPACE_MCP_AUTH_FLOW || 'auto').toLowerCase();
    if (authFlow === 'link' || authFlow === 'auto') {
        // Link mode (default): the user may be nowhere near this machine, so surface
        // a re-auth link instead of blocking on an interactive flow. The browser is
        // redirected by Google to <public base>/oauth/google/callback (served by the
        // opencode server), which writes the code to auth-code.json in the auth dir;
        // the next call exchanges it. A code the user just completed is consumed
        // here, and token.json is re-checked in case a sibling MCP process won the
        // single-use code race and refreshed it.
        const link = await tryLinkAuth(credentials);
        if (link.client) return link.client;
        if (link.authUrl) {
            throw new Error('Google Workspace MCP: the OAuth token expired or was revoked. '
                + 'Ask the user to re-authenticate: render this URL in your reply as a clickable markdown link, '
                + 'and after the user completes Google sign-in in their browser, retry the request. URL: ' + link.authUrl);
        }
        if (authFlow === 'link') {
            throw new Error('Google Workspace MCP: token refresh failed and no public callback URL is configured. '
                + 'Set GOOGLE_WORKSPACE_MCP_PUBLIC_URL (or write it to '
                + path.join(authDir(), 'public-url') + ', e.g. https://home.opencode.camalolo.com) '
                + 'so the re-auth redirect can reach this server.');
        }
        console.error('No public callback URL configured; falling back to interactive auth flows.');
    }
    if (authFlow === 'device') {
        await authenticateWithDeviceCode(credentials, oauth2Client);
    }
    else if (authFlow === 'browser') {
        await authenticateWithBrowser(oauth2Client);
    }
    else {
        try {
            await authenticateWithBrowser(oauth2Client);
        }
        catch (error) {
            console.error('Browser auth failed, falling back to device flow...');
            await authenticateWithDeviceCode(credentials, oauth2Client);
        }
    }
    return oauth2Client;
}
async function tryLinkAuth(credentials) {
    const base = await getPublicBaseUrl();
    if (!base) return {};
    for (let attempt = 0; attempt < 2; attempt++) {
        const linked = await exchangePendingCode(credentials, base);
        if (linked) return { client: linked };
        const latest = await loadToken();
        if (latest && latest.refresh_token) {
            const client = createOAuth2Client(credentials);
            client.setCredentials(latest);
            if (await tryRefreshToken(client)) return { client };
        }
    }
    return { authUrl: buildLinkAuthUrl(credentials, base) };
}
async function tryRefreshToken(oauth2Client) {
    try {
        const { credentials: newTokens } = await oauth2Client.refreshAccessToken();
        oauth2Client.setCredentials(newTokens);
        await saveToken(newTokens);
        return true;
    }
    catch (error) {
        console.error(`Token refresh failed: ${error.message}`);
        return false;
    }
}
function getCodePath() {
    return path.join(authDir(), 'auth-code.json');
}
// Public origin the browser will be redirected back to. The opencode server on
// that origin serves /oauth/google/callback and hands the code back through the
// auth dir (see packages/opencode .../handlers/oauth-callback.ts).
async function getPublicBaseUrl() {
    if (process.env.GOOGLE_WORKSPACE_MCP_PUBLIC_URL) {
        return process.env.GOOGLE_WORKSPACE_MCP_PUBLIC_URL.replace(/\/+$/, '');
    }
    try {
        const value = (await fs.readFile(path.join(authDir(), 'public-url'), 'utf-8')).trim();
        if (value) return value.replace(/\/+$/, '');
    }
    catch (error) {
        // not configured through a file; fall through
    }
    return null;
}
function buildLinkAuthUrl(credentials, base) {
    const creds = getOAuthClientConfig(credentials);
    const oauth2Client = new google.auth.OAuth2(creds.client_id, creds.client_secret, REDIRECT_URI);
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent',
        redirect_uri: base + '/oauth/google/callback',
        state: crypto.randomBytes(12).toString('hex'),
    });
    console.error('Re-authentication required. Open this URL in a browser:');
    console.error(authUrl);
    return authUrl;
}
// Exchange a code written by the server's OAuth callback route, if one is
// pending and fresh. Returns an authenticated client or null. The callback is
// single-use; failures clear the file so the next call surfaces a fresh link.
async function exchangePendingCode(credentials, base) {
    let raw;
    try {
        raw = await fs.readFile(getCodePath(), 'utf-8');
    }
    catch (error) {
        return null;
    }
    const clear = () => fs.unlink(getCodePath()).catch(() => { });
    let pending;
    try {
        pending = JSON.parse(raw);
    }
    catch (error) {
        await clear();
        return null;
    }
    if (!pending.code || !pending.received_at || Date.now() - pending.received_at > 10 * 60 * 1000) {
        await clear();
        return null;
    }
    const creds = getOAuthClientConfig(credentials);
    // The redirect_uri must match the one embedded in the original consent URL.
    const client = new google.auth.OAuth2(creds.client_id, creds.client_secret, base + '/oauth/google/callback');
    try {
        const { tokens } = await client.getToken(pending.code);
        const saved = {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            scope: tokens.scope,
            token_type: tokens.token_type,
            refresh_token_expires_in: tokens.refresh_token_expires_in,
            expiry_date: tokens.expiry_date,
        };
        client.setCredentials(saved);
        await saveToken(saved);
        await clear();
        console.error('Re-authentication complete; token saved.');
        return client;
    }
    catch (error) {
        console.error(`Callback code exchange failed (${error.message}); clearing it and requesting a new link.`);
        await clear();
        return null;
    }
}
//# sourceMappingURL=auth.js.map