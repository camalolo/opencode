#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { getAuthenticatedClient } from './auth.js';
import { registerGmailTools } from './tools/gmail.js';
import { registerCalendarTools } from './tools/calendar.js';
import { registerDriveTools } from './tools/drive.js';
import { registerDocsTools } from './tools/docs.js';
import { registerSheetsTools } from './tools/sheets.js';
import { registerSlidesTools } from './tools/slides.js';
import { registerPeopleTools } from './tools/people.js';
const SERVER_NAME = 'google-workspace-mcp';
const SERVER_VERSION = '1.0.2';
// Tool definitions for MCP
const TOOL_DEFINITIONS = [
    // Gmail tools
    {
        name: 'search_emails',
        description: 'Search emails using Gmail query syntax (e.g., "is:unread", "from:example@gmail.com")',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Gmail search query' },
                maxResults: { type: 'number', description: 'Maximum number of results (default: 10)' },
            },
            required: ['query'],
        },
    },
    {
        name: 'read_email',
        description: 'Read a specific email by its message ID (headers, decoded body, attachment metadata)',
        inputSchema: {
            type: 'object',
            properties: {
                messageId: { type: 'string', description: 'Gmail message ID' },
            },
            required: ['messageId'],
        },
    },
    {
        name: 'extract_email_images',
        description: 'Extract image parts (inline and attached) from an email and save them to disk as files. Returns local file paths; embeds the images in the response by default so multimodal models can see them directly.',
        inputSchema: {
            type: 'object',
            properties: {
                messageId: { type: 'string', description: 'Gmail message ID' },
                directory: { type: 'string', description: 'Target directory for the saved images (optional; defaults to a per-message folder under the system temp dir)' },
                embed: { type: 'boolean', description: 'Embed the images as image content in the response so multimodal models can see them directly (default true; svg and images over 3.5 MB stay disk-only)' },
            },
            required: ['messageId'],
        },
    },
    {
        name: 'send_email',
        description: 'Send a new email (supports optional file attachments)',
        inputSchema: {
            type: 'object',
            properties: {
                to: { type: 'string', description: 'Recipient email address' },
                subject: { type: 'string', description: 'Email subject' },
                body: { type: 'string', description: 'Email body text' },
                cc: { type: 'string', description: 'CC recipients (optional)' },
                bcc: { type: 'string', description: 'BCC recipients (optional)' },
                attachmentPaths: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Attachment file paths (optional)',
                },
                attachments: {
                    type: 'array',
                    description: 'Detailed attachments with optional filename/mimeType overrides',
                    items: {
                        type: 'object',
                        properties: {
                            filePath: { type: 'string', description: 'Attachment file path' },
                            filename: { type: 'string', description: 'Override attachment filename' },
                            mimeType: { type: 'string', description: 'Override attachment MIME type' },
                        },
                        required: ['filePath'],
                    },
                },
            },
            required: ['to', 'subject', 'body'],
        },
    },
    {
        name: 'reply_to_email',
        description: 'Reply to an existing email (threaded: In-Reply-To/References headers + same thread). Set draft=true to create a draft instead of sending.',
        inputSchema: {
            type: 'object',
            properties: {
                messageId: { type: 'string', description: 'ID of message to reply to' },
                body: { type: 'string', description: 'Reply body text' },
                draft: { type: 'boolean', description: 'Create as a draft reply instead of sending (optional, default false)' },
            },
            required: ['messageId', 'body'],
        },
    },
    {
        name: 'create_draft',
        description: 'Create an email draft. Pass in_reply_to (a Gmail message ID) to file the draft as a threaded reply with proper In-Reply-To/References headers.',
        inputSchema: {
            type: 'object',
            properties: {
                to: { type: 'string', description: 'Recipient email address' },
                subject: { type: 'string', description: 'Email subject' },
                body: { type: 'string', description: 'Email body text' },
                cc: { type: 'string', description: 'CC recipients (optional)' },
                bcc: { type: 'string', description: 'BCC recipients (optional)' },
                in_reply_to: { type: 'string', description: "Gmail message ID this draft replies to (optional). Adds In-Reply-To/References headers, files the draft into that message's thread." },
                thread_id: { type: 'string', description: 'Gmail thread ID to file the draft into (optional). Ignored when in_reply_to is given.' },
                references: { type: 'string', description: 'Explicit References header chain (optional). Defaults to the parent chain derived from in_reply_to.' },
            },
            required: ['to', 'subject', 'body'],
        },
    },
    {
        name: 'trash_email',
        description: 'Move an email to trash',
        inputSchema: {
            type: 'object',
            properties: {
                messageId: { type: 'string', description: 'Gmail message ID' },
            },
            required: ['messageId'],
        },
    },
    {
        name: 'mark_as_read',
        description: 'Mark an email as read',
        inputSchema: {
            type: 'object',
            properties: {
                messageId: { type: 'string', description: 'Gmail message ID' },
            },
            required: ['messageId'],
        },
    },
    {
        name: 'mark_as_unread',
        description: 'Mark an email as unread',
        inputSchema: {
            type: 'object',
            properties: {
                messageId: { type: 'string', description: 'Gmail message ID' },
            },
            required: ['messageId'],
        },
    },
    {
        name: 'list_labels',
        description: 'List all Gmail labels',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
    {
        name: 'add_label',
        description: 'Add a label to a message',
        inputSchema: {
            type: 'object',
            properties: {
                messageId: { type: 'string', description: 'Gmail message ID' },
                labelId: { type: 'string', description: 'Label ID to add' },
            },
            required: ['messageId', 'labelId'],
        },
    },
    {
        name: 'get_unsubscribe_options',
        description: 'Inspect List-Unsubscribe headers and available unsubscribe methods for an email',
        inputSchema: {
            type: 'object',
            properties: {
                messageId: { type: 'string', description: 'Gmail message ID' },
            },
            required: ['messageId'],
        },
    },
    {
        name: 'unsubscribe_email',
        description: 'Attempt unsubscribe via List-Unsubscribe (one-click POST, URL GET, or mailto draft fallback)',
        inputSchema: {
            type: 'object',
            properties: {
                messageId: { type: 'string', description: 'Gmail message ID' },
                method: {
                    type: 'string',
                    enum: ['auto', 'url_one_click', 'url_get', 'mailto'],
                    description: 'Unsubscribe strategy (default: auto)',
                },
                dryRun: { type: 'boolean', description: 'Preview action without executing it' },
                allowHttp: { type: 'boolean', description: 'Allow insecure http:// unsubscribe URLs (default: false)' },
            },
            required: ['messageId'],
        },
    },
    {
        name: 'get_profile',
        description: 'Get Gmail profile information',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
    // Calendar tools
    {
        name: 'list_calendars',
        description: 'List all available calendars',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
    {
        name: 'list_events',
        description: 'List upcoming calendar events',
        inputSchema: {
            type: 'object',
            properties: {
                calendarId: { type: 'string', description: 'Calendar ID (default: "primary")' },
                maxResults: { type: 'number', description: 'Maximum number of results (default: 10)' },
                timeMin: { type: 'string', description: 'Start time (ISO 8601 format)' },
                timeMax: { type: 'string', description: 'End time (ISO 8601 format)' },
            },
        },
    },
    {
        name: 'get_event',
        description: 'Get details of a specific calendar event',
        inputSchema: {
            type: 'object',
            properties: {
                calendarId: { type: 'string', description: 'Calendar ID (default: "primary")' },
                eventId: { type: 'string', description: 'Event ID' },
            },
            required: ['eventId'],
        },
    },
    {
        name: 'create_event',
        description: 'Create a new calendar event',
        inputSchema: {
            type: 'object',
            properties: {
                calendarId: { type: 'string', description: 'Calendar ID (default: "primary")' },
                summary: { type: 'string', description: 'Event title' },
                description: { type: 'string', description: 'Event description' },
                location: { type: 'string', description: 'Event location' },
                start: { type: 'string', description: 'Start time (ISO 8601 format)' },
                end: { type: 'string', description: 'End time (ISO 8601 format)' },
                attendees: { type: 'array', items: { type: 'string' }, description: 'Attendee email addresses' },
                timeZone: { type: 'string', description: 'Time zone' },
            },
            required: ['summary', 'start', 'end'],
        },
    },
    {
        name: 'update_event',
        description: 'Update an existing calendar event',
        inputSchema: {
            type: 'object',
            properties: {
                calendarId: { type: 'string', description: 'Calendar ID (default: "primary")' },
                eventId: { type: 'string', description: 'Event ID' },
                summary: { type: 'string', description: 'Event title' },
                description: { type: 'string', description: 'Event description' },
                location: { type: 'string', description: 'Event location' },
                start: { type: 'string', description: 'Start time (ISO 8601 format)' },
                end: { type: 'string', description: 'End time (ISO 8601 format)' },
                attendees: { type: 'array', items: { type: 'string' }, description: 'Attendee email addresses' },
            },
            required: ['eventId'],
        },
    },
    {
        name: 'delete_event',
        description: 'Delete a calendar event',
        inputSchema: {
            type: 'object',
            properties: {
                calendarId: { type: 'string', description: 'Calendar ID (default: "primary")' },
                eventId: { type: 'string', description: 'Event ID' },
            },
            required: ['eventId'],
        },
    },
    {
        name: 'find_free_time',
        description: 'Find free time slots across calendars',
        inputSchema: {
            type: 'object',
            properties: {
                timeMin: { type: 'string', description: 'Start time (ISO 8601 format)' },
                timeMax: { type: 'string', description: 'End time (ISO 8601 format)' },
                calendars: { type: 'array', items: { type: 'string' }, description: 'Calendar IDs to check' },
            },
            required: ['timeMin', 'timeMax'],
        },
    },
    {
        name: 'quick_add_event',
        description: 'Create event using natural language (e.g., "Lunch tomorrow at noon")',
        inputSchema: {
            type: 'object',
            properties: {
                calendarId: { type: 'string', description: 'Calendar ID (default: "primary")' },
                text: { type: 'string', description: 'Natural language event description' },
            },
            required: ['text'],
        },
    },
    // Drive tools
    {
        name: 'list_files',
        description: 'List files in Google Drive',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Drive query string' },
                maxResults: { type: 'number', description: 'Maximum number of results (default: 10)' },
                orderBy: { type: 'string', description: 'Order by (e.g., "modifiedTime desc")' },
            },
        },
    },
    {
        name: 'get_file',
        description: 'Get metadata for a specific file',
        inputSchema: {
            type: 'object',
            properties: {
                fileId: { type: 'string', description: 'File ID' },
            },
            required: ['fileId'],
        },
    },
    {
        name: 'search_files',
        description: 'Search files by name or content',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query' },
                maxResults: { type: 'number', description: 'Maximum number of results (default: 20)' },
            },
            required: ['query'],
        },
    },
    {
        name: 'create_folder',
        description: 'Create a new folder in Drive',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Folder name' },
                parentId: { type: 'string', description: 'Parent folder ID (optional)' },
            },
            required: ['name'],
        },
    },
    {
        name: 'delete_file',
        description: 'Delete a file from Drive',
        inputSchema: {
            type: 'object',
            properties: {
                fileId: { type: 'string', description: 'File ID' },
            },
            required: ['fileId'],
        },
    },
    {
        name: 'copy_file',
        description: 'Create a copy of a file',
        inputSchema: {
            type: 'object',
            properties: {
                fileId: { type: 'string', description: 'File ID to copy' },
                name: { type: 'string', description: 'New file name (optional)' },
                parentId: { type: 'string', description: 'Parent folder ID (optional)' },
            },
            required: ['fileId'],
        },
    },
    {
        name: 'move_file',
        description: 'Move a file to a different folder',
        inputSchema: {
            type: 'object',
            properties: {
                fileId: { type: 'string', description: 'File ID' },
                newParentId: { type: 'string', description: 'New parent folder ID' },
            },
            required: ['fileId', 'newParentId'],
        },
    },
    {
        name: 'share_file',
        description: 'Share a file with someone',
        inputSchema: {
            type: 'object',
            properties: {
                fileId: { type: 'string', description: 'File ID' },
                email: { type: 'string', description: 'Email address to share with' },
                role: { type: 'string', enum: ['reader', 'writer', 'commenter'], description: 'Permission role' },
                sendNotification: { type: 'boolean', description: 'Send email notification' },
            },
            required: ['fileId', 'email'],
        },
    },
    {
        name: 'get_file_content',
        description: 'Get content of a text file',
        inputSchema: {
            type: 'object',
            properties: {
                fileId: { type: 'string', description: 'File ID' },
                mimeType: { type: 'string', description: 'MIME type (optional)' },
            },
            required: ['fileId'],
        },
    },
    {
        name: 'export_file',
        description: 'Export a Google Doc/Sheet/Slides to another format',
        inputSchema: {
            type: 'object',
            properties: {
                fileId: { type: 'string', description: 'File ID' },
                mimeType: { type: 'string', description: 'Export MIME type (e.g., "text/plain", "application/pdf")' },
            },
            required: ['fileId', 'mimeType'],
        },
    },
    {
        name: 'get_storage_quota',
        description: 'Get Drive storage quota information',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
    // Docs tools
    {
        name: 'list_doc_structure',
        description: 'List high-level structure of a Google Doc',
        inputSchema: {
            type: 'object',
            properties: {
                documentId: { type: 'string', description: 'Google Doc document ID' },
            },
            required: ['documentId'],
        },
    },
    {
        name: 'read_doc_text',
        description: 'Read plain text content from a Google Doc',
        inputSchema: {
            type: 'object',
            properties: {
                documentId: { type: 'string', description: 'Google Doc document ID' },
            },
            required: ['documentId'],
        },
    },
    {
        name: 'create_doc',
        description: 'Create a new Google Doc with optional initial content',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Document title' },
                content: { type: 'string', description: 'Initial document text (optional)' },
            },
            required: ['title'],
        },
    },
    {
        name: 'append_doc_text',
        description: 'Append text to the end of a Google Doc',
        inputSchema: {
            type: 'object',
            properties: {
                documentId: { type: 'string', description: 'Google Doc document ID' },
                text: { type: 'string', description: 'Text to append' },
            },
            required: ['documentId', 'text'],
        },
    },
    // Sheets tools
    {
        name: 'get_sheet_values',
        description: 'Read values from a spreadsheet range',
        inputSchema: {
            type: 'object',
            properties: {
                spreadsheetId: { type: 'string', description: 'Spreadsheet ID' },
                range: { type: 'string', description: 'A1 range (e.g., Sheet1!A1:C10)' },
            },
            required: ['spreadsheetId', 'range'],
        },
    },
    {
        name: 'update_sheet_values',
        description: 'Update values in a spreadsheet range',
        inputSchema: {
            type: 'object',
            properties: {
                spreadsheetId: { type: 'string', description: 'Spreadsheet ID' },
                range: { type: 'string', description: 'A1 range (e.g., Sheet1!A1:C10)' },
                values: { type: 'array', items: { type: 'array', items: {} }, description: '2D values array' },
                valueInputOption: { type: 'string', enum: ['RAW', 'USER_ENTERED'] },
            },
            required: ['spreadsheetId', 'range', 'values'],
        },
    },
    {
        name: 'append_sheet_values',
        description: 'Append rows to a spreadsheet range',
        inputSchema: {
            type: 'object',
            properties: {
                spreadsheetId: { type: 'string', description: 'Spreadsheet ID' },
                range: { type: 'string', description: 'A1 range (e.g., Sheet1!A:C)' },
                values: { type: 'array', items: { type: 'array', items: {} }, description: '2D values array' },
                valueInputOption: { type: 'string', enum: ['RAW', 'USER_ENTERED'] },
            },
            required: ['spreadsheetId', 'range', 'values'],
        },
    },
    {
        name: 'create_spreadsheet',
        description: 'Create a new Google Spreadsheet',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Spreadsheet title' },
                sheetTitle: { type: 'string', description: 'Initial sheet tab name' },
            },
            required: ['title'],
        },
    },
    // Slides tools
    {
        name: 'get_presentation',
        description: 'Get metadata and slides for a Google Slides presentation',
        inputSchema: {
            type: 'object',
            properties: {
                presentationId: { type: 'string', description: 'Presentation ID' },
            },
            required: ['presentationId'],
        },
    },
    {
        name: 'create_presentation',
        description: 'Create a new Google Slides presentation',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Presentation title' },
            },
            required: ['title'],
        },
    },
    {
        name: 'create_slide',
        description: 'Create a slide in an existing presentation',
        inputSchema: {
            type: 'object',
            properties: {
                presentationId: { type: 'string', description: 'Presentation ID' },
                layout: { type: 'string', description: 'Layout enum, e.g. TITLE_AND_BODY' },
            },
            required: ['presentationId'],
        },
    },
    // People tools
    {
        name: 'list_contacts',
        description: 'List contacts from Google People',
        inputSchema: {
            type: 'object',
            properties: {
                pageSize: { type: 'number', description: 'Page size (default 50)' },
                pageToken: { type: 'string', description: 'Pagination token' },
            },
        },
    },
    {
        name: 'search_contacts',
        description: 'Search contacts by name/email/phone',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query' },
                pageSize: { type: 'number', description: 'Page size (default 20)' },
            },
            required: ['query'],
        },
    },
    {
        name: 'create_contact',
        description: 'Create a contact in Google People',
        inputSchema: {
            type: 'object',
            properties: {
                givenName: { type: 'string', description: 'First name' },
                familyName: { type: 'string', description: 'Last name' },
                email: { type: 'string', description: 'Email address' },
                phone: { type: 'string', description: 'Phone number' },
                company: { type: 'string', description: 'Company name' },
            },
            required: ['givenName'],
        },
    },
    {
        name: 'get_contact',
        description: 'Get a contact by People resource name',
        inputSchema: {
            type: 'object',
            properties: {
                resourceName: { type: 'string', description: 'Resource name like people/c123456789' },
            },
            required: ['resourceName'],
        },
    },
];
async function main() {
    console.error('Starting Google Workspace MCP Server...');
    let allToolsPromise = null;
    const getAllTools = async () => {
        if (!allToolsPromise) {
            allToolsPromise = (async () => {
                const auth = await getAuthenticatedClient();
                console.error('Authentication successful!');
                const gmailTools = registerGmailTools(auth);
                const calendarTools = registerCalendarTools(auth);
                const driveTools = registerDriveTools(auth);
                const docsTools = registerDocsTools(auth);
                const sheetsTools = registerSheetsTools(auth);
                const slidesTools = registerSlidesTools(auth);
                const peopleTools = registerPeopleTools(auth);
                return {
                    ...gmailTools,
                    ...calendarTools,
                    ...driveTools,
                    ...docsTools,
                    ...sheetsTools,
                    ...slidesTools,
                    ...peopleTools,
                };
            })();
        }
        return allToolsPromise;
    };
    // Create MCP server
    const server = new Server({
        name: SERVER_NAME,
        version: SERVER_VERSION,
    }, {
        capabilities: {
            tools: {},
        },
    });
    // Handle list_tools request
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: TOOL_DEFINITIONS,
        };
    });
    // Handle call_tool request
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        try {
            const allTools = await getAllTools();
            const tool = allTools[name];
            if (!tool) {
                throw new Error(`Unknown tool: ${name}`);
            }
            const result = await tool(args || {});
            // Tools can request image embedding via a private `_embed_images` key:
            // it is stripped from the JSON text block and re-emitted as MCP image
            // content so multimodal clients (e.g. opencode) attach the images to the
            // model context the same way as chat-uploaded images.
            const embedded = Array.isArray(result?._embed_images) ? result._embed_images : [];
            const payload = embedded.length ? { ...result, _embed_images: undefined } : result;
            const content = [
                {
                    type: 'text',
                    text: JSON.stringify(payload, null, 2),
                },
                ...embedded
                    .filter(image => image?.data && image?.mimeType)
                    .map(image => ({ type: 'image', data: image.data, mimeType: image.mimeType })),
            ];
            return { content };
        }
        catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error: ${error.message}`,
                    },
                ],
                isError: true,
            };
        }
    });
    // Start server with stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Google Workspace MCP Server is running!');
}
main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map