# Changelog

All notable changes to this project are documented in this file.

## [1.0.2] - 2026-02-17
### Fixed
- Prevented MCP startup hangs by deferring OAuth initialization until the first `call_tool` request.
- Ensured `list_tools` can return promptly even when OAuth has not completed yet.

### Changed
- Updated setup/documentation to use published npm package install and Manus-ready config examples.

## [1.0.1] - 2026-02-17
### Added
- Added device-code OAuth authentication flow for environments where localhost callback/browser flow cannot complete.
- Added auth mode selection via `GOOGLE_WORKSPACE_MCP_AUTH_FLOW` (`auto`, `browser`, `device`).

### Changed
- Expanded OAuth scopes to include Docs, Sheets, Slides, and People APIs.

## [1.0.0] - 2026-02-17
### Added
- Initial open-source release with unified Google Workspace MCP server tools:
  Gmail, Calendar, Drive, Docs, Sheets, Slides, and People.
