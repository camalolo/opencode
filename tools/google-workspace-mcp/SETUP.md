# Quick Setup Guide

## What You Built
A unified Google Workspace MCP server with **45 tools** across:
- **Gmail** (11)
- **Calendar** (8)
- **Drive** (11)
- **Docs** (4)
- **Sheets** (4)
- **Slides** (3)
- **People** (4)

## Recommended Install (Published Package)
```bash
npx -y @alanxchen/google-workspace-mcp@1.0.2
```

## OAuth Credentials Setup
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create/select a project
3. Enable APIs:
   - Gmail API
   - Google Calendar API
   - Google Drive API
   - Google Docs API
   - Google Sheets API
   - Google Slides API
   - Google People API
4. Configure OAuth consent screen and add scopes:
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/drive`
   - `https://www.googleapis.com/auth/documents`
   - `https://www.googleapis.com/auth/spreadsheets`
   - `https://www.googleapis.com/auth/presentations`
   - `https://www.googleapis.com/auth/contacts`
5. Create OAuth client ID (**Desktop app**) and download credentials JSON
6. Save credentials:
   - Windows: `%USERPROFILE%\.google-workspace-mcp\credentials.json`
   - macOS/Linux: `~/.google-workspace-mcp/credentials.json`

## MCP Client Config
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

If sandbox browser callback is blocked, force device flow:
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

## Authentication Notes
- Tokens are saved in `~/.google-workspace-mcp/token.json`
- OAuth is initialized on first tool call (not at startup)
- Default auth mode is automatic browser -> device fallback
- Force mode with `GOOGLE_WORKSPACE_MCP_AUTH_FLOW=browser|device|auto`

## Troubleshooting
### Tool discovery times out / MCP appears hung
Use version `1.0.2+` (startup auth is non-blocking).

### Credentials file not found
Check path:
- Windows:
  ```powershell
  dir $env:USERPROFILE\.google-workspace-mcp\credentials.json
  ```
- macOS/Linux:
  ```bash
  ls ~/.google-workspace-mcp/credentials.json
  ```

### Force new OAuth login
- macOS/Linux:
  ```bash
  rm -f ~/.google-workspace-mcp/token.json
  ```
- Windows PowerShell:
  ```powershell
  Remove-Item "$env:USERPROFILE\.google-workspace-mcp\token.json" -ErrorAction SilentlyContinue
  ```

### Browser callback flow fails in sandbox
Set:
```json
"env": { "GOOGLE_WORKSPACE_MCP_AUTH_FLOW": "device" }
```
