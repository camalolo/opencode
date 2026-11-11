# Google Workspace MCP Server

A unified Model Context Protocol (MCP) server for Gmail, Google Calendar, Google Drive, Google Docs, Google Sheets, Google Slides, and Google People.

## Highlights
- 45 tools across Gmail, Calendar, Drive, Docs, Sheets, Slides, and People APIs
- Published npm package for easy MCP client integration
- OAuth token caching to avoid repeated auth prompts
- Robust auth modes for both local desktop and sandboxed environments
- Non-blocking MCP startup (tool discovery is not blocked by auth)

## Package
```bash
npx -y @alanxchen/google-workspace-mcp@1.0.2
```

## Features
### Gmail (11 tools)
- Search emails with Gmail query syntax
- Read, send, and reply to emails
- Send emails with optional file attachments (`attachmentPaths` or `attachments`)
- Create drafts
- Trash emails, mark as read/unread
- List and manage labels
- Get profile information

### Calendar (8 tools)
- List calendars and events
- Create, update, and delete events
- Find free time slots
- Quick add events with natural language

### Drive (11 tools)
- List and search files
- Get file metadata and content
- Create folders, copy/move/delete files
- Share files with permissions
- Export Google Docs/Sheets/Slides
- Get storage quota

### Docs (4 tools)
- List document structure
- Read document text
- Create docs
- Append text to docs

### Sheets (4 tools)
- Read cell ranges
- Update cell ranges
- Append rows
- Create spreadsheets

### Slides (3 tools)
- Get presentation metadata
- Create presentations
- Create slides

### People (4 tools)
- List contacts
- Search contacts
- Create contacts
- Get contact details

## Prerequisites
- Node.js 18+
- Google Cloud project with these APIs enabled:
  - Gmail API
  - Google Calendar API
  - Google Drive API
  - Google Docs API
  - Google Sheets API
  - Google Slides API
  - Google People API
- OAuth 2.0 Desktop app credentials JSON

## OAuth Setup
1. In Google Cloud Console, configure OAuth consent screen and add required scopes:
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/drive`
   - `https://www.googleapis.com/auth/documents`
   - `https://www.googleapis.com/auth/spreadsheets`
   - `https://www.googleapis.com/auth/presentations`
   - `https://www.googleapis.com/auth/contacts`
2. Create OAuth client credentials with application type: **Desktop app**
3. Save credentials JSON to:
   - Windows: `%USERPROFILE%\.google-workspace-mcp\credentials.json`
   - macOS/Linux: `~/.google-workspace-mcp/credentials.json`

## Authentication Behavior
- Credentials are loaded from `~/.google-workspace-mcp/credentials.json`
- Tokens are saved at `~/.google-workspace-mcp/token.json`
- Startup is non-blocking; auth is initialized on first tool call
- Auth flow mode is controlled by `GOOGLE_WORKSPACE_MCP_AUTH_FLOW`:
  - `auto` (default): browser callback first, then device-code fallback
  - `browser`: force localhost callback browser flow
  - `device`: force device-code flow

## Client Configuration
### Manus
```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "npx",
      "args": ["-y", "@alanxchen/google-workspace-mcp@1.0.2"]
    }
  }
}
```

If browser callback cannot complete in the sandbox, use device flow:

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "npx",
      "args": ["-y", "@alanxchen/google-workspace-mcp@1.0.2"],
      "env": {
        "GOOGLE_WORKSPACE_MCP_AUTH_FLOW": "device"
      }
    }
  }
}
```

### Claude Desktop
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`  
**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "npx",
      "args": ["-y", "@alanxchen/google-workspace-mcp@1.0.2"]
    }
  }
}
```

### OpenClaw / Other MCP clients
Use the same stdio command:

```json
{
  "google-workspace": {
    "command": "npx",
    "args": ["-y", "@alanxchen/google-workspace-mcp@1.0.2"]
  }
}
```

## Local Development
```bash
npm install
npm run build
npm start
```

## Example Prompts
- "Search my unread emails from last week"
- "Create a calendar event for tomorrow at 2pm"
- "List Drive files modified in the last 7 days"
- "Append these rows to my Google Sheet"
- "Find contact details for Jane in Google Contacts"

## Security
- Tokens are stored locally in user home directory
- No credentials or tokens are packaged in npm release artifacts
- Never commit `credentials.json` or `token.json`
- Revoke OAuth grants at https://myaccount.google.com/permissions

## Architecture
```
src/
├── index.ts          # MCP server entry + request handlers
├── auth.ts           # OAuth auth + token management
└── tools/            # Google Workspace capability handlers
```

## License
MIT
