import { google } from 'googleapis';
import fs from 'fs/promises';
import path from 'path';
import { createServer } from 'http';
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
// Store tokens in user's home directory
const getTokenPath = () => {
    const configDir = path.join(os.homedir(), '.google-workspace-mcp');
    return path.join(configDir, 'token.json');
};
const getCredentialsPath = () => {
    const configDir = path.join(os.homedir(), '.google-workspace-mcp');
    return path.join(configDir, 'credentials.json');
};
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
    const configDir = path.join(os.homedir(), '.google-workspace-mcp');
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
        // Check if token needs refresh
        try {
            // Try to refresh if we have a refresh token
            if (token.refresh_token) {
                const { credentials: newTokens } = await oauth2Client.refreshAccessToken();
                oauth2Client.setCredentials(newTokens);
                await saveToken(newTokens);
            }
            return oauth2Client;
        }
        catch (error) {
            console.error('Token refresh failed, re-authenticating...');
        }
    }
    // No valid token, need to authenticate
    const authFlow = (process.env.GOOGLE_WORKSPACE_MCP_AUTH_FLOW || 'auto').toLowerCase();
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
//# sourceMappingURL=auth.js.map