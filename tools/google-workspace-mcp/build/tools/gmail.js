import { google } from 'googleapis';
import { promises as fs } from 'fs';
import path from 'path';
const MIME_BY_EXTENSION = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.zip': 'application/zip',
};
const encodeBase64Url = (input) => Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const resolveMimeType = (filePath, overrideMimeType) => {
    if (overrideMimeType?.trim())
        return overrideMimeType.trim();
    const ext = path.extname(filePath).toLowerCase();
    return MIME_BY_EXTENSION[ext] || 'application/octet-stream';
};
const encodeAttachmentChunks = (contentBase64, lineLength = 76) => {
    const chunks = [];
    for (let i = 0; i < contentBase64.length; i += lineLength) {
        chunks.push(contentBase64.slice(i, i + lineLength));
    }
    return chunks.join('\r\n');
};
async function buildRawEmailMessage(args) {
    const { to, subject, body, cc, bcc, attachments = [] } = args;
    const validAttachments = attachments.filter(a => a?.filePath?.trim());
    if (!validAttachments.length) {
        const headerLines = [
            `To: ${to}`,
            ...(cc ? [`Cc: ${cc}`] : []),
            ...(bcc ? [`Bcc: ${bcc}`] : []),
            `Subject: ${subject}`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset="UTF-8"',
            'Content-Transfer-Encoding: 7bit',
        ];
        const plainEmail = [...headerLines, '', body].join('\r\n');
        return encodeBase64Url(plainEmail);
    }
    const boundary = `mcp_boundary_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const parts = [];
    const multipartHeaderLines = [
        `To: ${to}`,
        ...(cc ? [`Cc: ${cc}`] : []),
        ...(bcc ? [`Bcc: ${bcc}`] : []),
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ];
    parts.push([
        ...multipartHeaderLines,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: 7bit',
        '',
        body,
        '',
    ].join('\r\n'));
    for (const attachment of validAttachments) {
        const absolutePath = path.resolve(attachment.filePath);
        const fileBuffer = await fs.readFile(absolutePath);
        const contentBase64 = fileBuffer.toString('base64');
        const filename = attachment.filename?.trim() || path.basename(absolutePath);
        const mimeType = resolveMimeType(absolutePath, attachment.mimeType);
        parts.push([
            `--${boundary}`,
            `Content-Type: ${mimeType}; name="${filename}"`,
            `Content-Disposition: attachment; filename="${filename}"`,
            'Content-Transfer-Encoding: base64',
            '',
            encodeAttachmentChunks(contentBase64),
            '',
        ].join('\r\n'));
    }
    parts.push(`--${boundary}--`);
    return encodeBase64Url(parts.join('\r\n'));
}
function parseListUnsubscribeHeader(value) {
    if (!value?.trim())
        return [];
    const methods = [];
    const angleMatches = [...value.matchAll(/<([^>]+)>/g)].map(m => m[1]?.trim()).filter(Boolean);
    const tokens = angleMatches.length ? angleMatches : value.split(',').map(part => part.trim());
    for (const token of tokens) {
        if (!token)
            continue;
        if (token.startsWith('mailto:')) {
            methods.push({ type: 'mailto', value: token });
            continue;
        }
        if (token.startsWith('http://') || token.startsWith('https://')) {
            methods.push({ type: 'url', value: token });
        }
    }
    return methods;
}
function parseMailtoAddress(mailtoUri) {
    try {
        const uri = new URL(mailtoUri);
        return decodeURIComponent(uri.pathname || '').trim();
    }
    catch {
        return mailtoUri.replace(/^mailto:/i, '').split('?')[0]?.trim() || '';
    }
}
function hasOneClickHeader(listUnsubscribePost) {
    return (listUnsubscribePost || '').toLowerCase().includes('list-unsubscribe=one-click');
}
// Fetch the threading context of a message (Gmail message ID) needed to reply to it:
// sender, subject, RFC822 Message-ID header, existing References chain and thread ID.
async function resolveReplyContext(gmail, messageId) {
    const original = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Message-ID', 'References'],
    });
    const headers = original.data.payload?.headers || [];
    const getHeader = (name) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
    return {
        threadId: original.data.threadId,
        from: getHeader('from'),
        subject: getHeader('subject'),
        messageIdHeader: getHeader('message-id'),
        referencesHeader: getHeader('references'),
    };
}
export function registerGmailTools(auth) {
    const gmail = google.gmail({ version: 'v1', auth });
    return {
        // Search emails
        search_emails: async (args) => {
            const { query, maxResults = 5, detail = 'summary' } = args;
            const response = await gmail.users.messages.list({
                userId: 'me',
                q: query,
                maxResults,
            });
            const messages = response.data.messages || [];
            const details = [];
            for (const message of messages.slice(0, maxResults)) {
                const detailResp = await gmail.users.messages.get({
                    userId: 'me',
                    id: message.id,
                    format: 'metadata',
                    metadataHeaders: ['From', 'To', 'Subject', 'Date'],
                });
                const headers = detailResp.data.payload?.headers || [];
                const getHeader = (name) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
                const snippet = (detailResp.data.snippet || '').slice(0, 200);
                if (detail === 'full') {
                    details.push({
                        id: message.id,
                        threadId: message.threadId,
                        from: getHeader('from'),
                        to: getHeader('to'),
                        subject: getHeader('subject'),
                        date: getHeader('date'),
                        snippet,
                    });
                }
                else {
                    details.push({
                        id: message.id,
                        from: getHeader('from'),
                        subject: getHeader('subject'),
                        date: getHeader('date'),
                        snippet: snippet.slice(0, 120),
                    });
                }
            }
            return {
                count: details.length,
                messages: details,
            };
        },
        // Read email
        read_email: async (args) => {
            const { messageId } = args;
            const message = await gmail.users.messages.get({
                userId: 'me',
                id: messageId,
                format: 'full',
            });
            const headers = message.data.payload?.headers || [];
            const getHeader = (name) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
            // Extract body: walk the full MIME tree (nested multipart/alternative,
            // multipart/mixed, ...), prefer text/plain, fall back to stripped text/html.
            const decodePart = (part) => {
                const raw = Buffer.from(part.body.data, 'base64');
                const ctHeader = part.headers?.find(h => h.name?.toLowerCase() === 'content-type')?.value || '';
                const charset = /charset=["']?([^;"'\s]+)/i.exec(ctHeader)?.[1] || 'utf-8';
                try {
                    return new TextDecoder(charset, { fatal: false }).decode(raw);
                }
                catch {
                    return raw.toString('utf-8');
                }
            };
            let body = '';
            let htmlBody = '';
            const walkParts = (part) => {
                if (!part)
                    return;
                if (part.body?.data && !part.body.attachmentId) {
                    if (part.mimeType === 'text/plain' && !body) {
                        body = decodePart(part);
                    }
                    else if (part.mimeType === 'text/html' && !htmlBody) {
                        htmlBody = decodePart(part);
                    }
                }
                for (const child of part.parts || []) walkParts(child);
            };
            walkParts(message.data.payload);
            if (!body && htmlBody) {
                body = htmlBody
                    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                    .replace(/<br\s*\/?[^>]*>/gi, '\n')
                    .replace(/<\/(p|div|tr|table|li|h[1-6]|blockquote)>/gi, '\n')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/&nbsp;/gi, ' ')
                    .replace(/&amp;/gi, '&')
                    .replace(/&lt;/gi, '<')
                    .replace(/&gt;/gi, '>')
                    .replace(/&quot;/gi, '"')
                    .replace(/&#39;|&apos;/gi, "'")
                    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
                    .replace(/[ \t]+/g, ' ')
                    .replace(/\n\s*\n\s*\n+/g, '\n\n')
                    .trim();
            }
            return {
                id: message.data.id,
                threadId: message.data.threadId,
                from: getHeader('from'),
                to: getHeader('to'),
                cc: getHeader('cc'),
                subject: getHeader('subject'),
                date: getHeader('date'),
                body: body || message.data.snippet,
                labels: message.data.labelIds,
            };
        },
        // Send email
        send_email: async (args) => {
            const { to, subject, body, cc, bcc, attachments = [], attachmentPaths = [] } = args;
            const normalizedAttachments = [
                ...attachments,
                ...attachmentPaths.map(filePath => ({ filePath })),
            ];
            const raw = await buildRawEmailMessage({
                to,
                subject,
                body,
                cc,
                bcc,
                attachments: normalizedAttachments,
            });
            const response = await gmail.users.messages.send({
                userId: 'me',
                requestBody: {
                    raw,
                },
            });
            return {
                id: response.data.id,
                threadId: response.data.threadId,
                status: 'sent',
                attachmentsCount: normalizedAttachments.filter(a => a?.filePath?.trim()).length,
            };
        },
        // Reply to email (send, or create a draft with draft: true)
        reply_to_email: async (args) => {
            const { messageId, body, draft = false } = args;
            const replyContext = await resolveReplyContext(gmail, messageId);
            // RFC822 header block and body are separated by one blank line which must
            // survive as its own element of the join.
            const headerLines = [
                `To: ${replyContext.from}`,
                `Subject: Re: ${replyContext.subject.replace(/^((re|fwd?)(\[\d+\])?\s*:\s*)+/i, '')}`,
                `In-Reply-To: ${replyContext.messageIdHeader}`,
            ];
            const references = [replyContext.referencesHeader, replyContext.messageIdHeader]
                .filter(Boolean)
                .join(' ');
            if (references)
                headerLines.push(`References: ${references}`);
            const email = [...headerLines, '', body].join('\n');
            const encodedEmail = encodeBase64Url(email);
            if (draft) {
                const response = await gmail.users.drafts.create({
                    userId: 'me',
                    requestBody: {
                        message: {
                            raw: encodedEmail,
                            threadId: replyContext.threadId,
                        },
                    },
                });
                return {
                    id: response.data.id,
                    messageId: response.data.message?.id,
                    threadId: response.data.message?.threadId,
                    status: 'draft_created',
                };
            }
            const response = await gmail.users.messages.send({
                userId: 'me',
                requestBody: {
                    raw: encodedEmail,
                    threadId: replyContext.threadId,
                },
            });
            return {
                id: response.data.id,
                threadId: response.data.threadId,
                status: 'sent',
            };
        },
        // Create draft (standalone, or a threaded reply draft via in_reply_to)
        create_draft: async (args) => {
            const { to, subject, body, cc, bcc, in_reply_to, thread_id, references } = args;
            const headerLines = [
                `To: ${to}`,
                ...(cc ? [`Cc: ${cc}`] : []),
                ...(bcc ? [`Bcc: ${bcc}`] : []),
                `Subject: ${subject}`,
            ];
            let threadId = thread_id;
            if (in_reply_to) {
                const replyContext = await resolveReplyContext(gmail, in_reply_to);
                headerLines.push(`In-Reply-To: ${replyContext.messageIdHeader}`);
                const chain = references || [replyContext.referencesHeader, replyContext.messageIdHeader]
                    .filter(Boolean)
                    .join(' ');
                if (chain)
                    headerLines.push(`References: ${chain}`);
                threadId = replyContext.threadId;
            }
            else if (references) {
                headerLines.push(`References: ${references}`);
            }
            // The blank line below is the RFC822 header/body separator — keep it.
            const email = [...headerLines, '', body].join('\n');
            const encodedEmail = encodeBase64Url(email);
            const message = { raw: encodedEmail };
            if (threadId)
                message.threadId = threadId;
            const response = await gmail.users.drafts.create({
                userId: 'me',
                requestBody: {
                    message,
                },
            });
            return {
                id: response.data.id,
                message: response.data.message,
                status: 'draft_created',
            };
        },
        // Delete/trash email
        trash_email: async (args) => {
            const { messageId } = args;
            await gmail.users.messages.trash({
                userId: 'me',
                id: messageId,
            });
            return { id: messageId, status: 'trashed' };
        },
        // Mark as read/unread
        mark_as_read: async (args) => {
            const { messageId } = args;
            await gmail.users.messages.modify({
                userId: 'me',
                id: messageId,
                requestBody: {
                    removeLabelIds: ['UNREAD'],
                },
            });
            return { id: messageId, status: 'marked_read' };
        },
        mark_as_unread: async (args) => {
            const { messageId } = args;
            await gmail.users.messages.modify({
                userId: 'me',
                id: messageId,
                requestBody: {
                    addLabelIds: ['UNREAD'],
                },
            });
            return { id: messageId, status: 'marked_unread' };
        },
        // List labels
        list_labels: async () => {
            const response = await gmail.users.labels.list({
                userId: 'me',
            });
            return {
                labels: response.data.labels?.map(label => ({
                    id: label.id,
                    name: label.name,
                    type: label.type,
                })),
            };
        },
        // Add label to message
        add_label: async (args) => {
            const { messageId, labelId } = args;
            await gmail.users.messages.modify({
                userId: 'me',
                id: messageId,
                requestBody: {
                    addLabelIds: [labelId],
                },
            });
            return { id: messageId, labelId, status: 'label_added' };
        },
        // Inspect unsubscribe metadata for an email
        get_unsubscribe_options: async (args) => {
            const { messageId } = args;
            const message = await gmail.users.messages.get({
                userId: 'me',
                id: messageId,
                format: 'metadata',
                metadataHeaders: ['From', 'Subject', 'List-Unsubscribe', 'List-Unsubscribe-Post'],
            });
            const headers = message.data.payload?.headers || [];
            const getHeader = (name) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
            const from = getHeader('from');
            const subject = getHeader('subject');
            const listUnsubscribe = getHeader('list-unsubscribe');
            const listUnsubscribePost = getHeader('list-unsubscribe-post');
            const methods = parseListUnsubscribeHeader(listUnsubscribe);
            const oneClick = hasOneClickHeader(listUnsubscribePost);
            return {
                id: messageId,
                from,
                subject,
                listUnsubscribe,
                listUnsubscribePost,
                oneClick,
                methods,
                recommended: methods.find(m => m.type === 'url' && m.value.startsWith('https://')) || methods[0] || null,
            };
        },
        // Attempt unsubscribe using List-Unsubscribe headers
        unsubscribe_email: async (args) => {
            const { messageId, method = 'auto', dryRun = false, allowHttp = false } = args;
            const message = await gmail.users.messages.get({
                userId: 'me',
                id: messageId,
                format: 'metadata',
                metadataHeaders: ['From', 'Subject', 'List-Unsubscribe', 'List-Unsubscribe-Post'],
            });
            const headers = message.data.payload?.headers || [];
            const getHeader = (name) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
            const from = getHeader('from');
            const subject = getHeader('subject');
            const listUnsubscribe = getHeader('list-unsubscribe');
            const listUnsubscribePost = getHeader('list-unsubscribe-post');
            const methods = parseListUnsubscribeHeader(listUnsubscribe);
            if (!methods.length) {
                return {
                    id: messageId,
                    from,
                    subject,
                    status: 'no_unsubscribe_header',
                    detail: 'No List-Unsubscribe method found on this email.',
                };
            }
            const oneClick = hasOneClickHeader(listUnsubscribePost);
            const httpsUrlMethod = methods.find(m => m.type === 'url' && m.value.startsWith('https://'));
            const anyUrlMethod = methods.find(m => m.type === 'url');
            const mailtoMethod = methods.find(m => m.type === 'mailto');
            const selected = (() => {
                if (method === 'mailto')
                    return mailtoMethod;
                if (method === 'url_get')
                    return httpsUrlMethod || anyUrlMethod;
                if (method === 'url_one_click')
                    return httpsUrlMethod;
                if (oneClick && httpsUrlMethod)
                    return httpsUrlMethod;
                return httpsUrlMethod || anyUrlMethod || mailtoMethod;
            })();
            if (!selected) {
                return {
                    id: messageId,
                    from,
                    subject,
                    status: 'unsupported_unsubscribe_method',
                    methods,
                };
            }
            if (selected.type === 'mailto') {
                const to = parseMailtoAddress(selected.value);
                const emailSubject = `Unsubscribe request${subject ? `: ${subject}` : ''}`;
                const emailBody = [
                    'Please unsubscribe this address from your mailing list.',
                    '',
                    `Original sender: ${from || 'unknown'}`,
                    `Original subject: ${subject || 'unknown'}`,
                ].join('\n');
                if (dryRun) {
                    return {
                        id: messageId,
                        from,
                        subject,
                        status: 'dry_run',
                        action: 'create_draft',
                        to,
                        draftSubject: emailSubject,
                    };
                }
                const raw = await buildRawEmailMessage({
                    to,
                    subject: emailSubject,
                    body: emailBody,
                });
                const draft = await gmail.users.drafts.create({
                    userId: 'me',
                    requestBody: { message: { raw } },
                });
                return {
                    id: messageId,
                    from,
                    subject,
                    status: 'draft_created_for_manual_send',
                    method: selected,
                    draftId: draft.data.id,
                };
            }
            const selectedUrl = selected.value;
            const isHttp = selectedUrl.startsWith('http://');
            if (isHttp && !allowHttp) {
                return {
                    id: messageId,
                    from,
                    subject,
                    status: 'blocked_insecure_url',
                    url: selectedUrl,
                    detail: 'Refusing HTTP unsubscribe URL unless allowHttp=true.',
                };
            }
            const requestMode = method === 'url_get'
                ? 'get'
                : (method === 'url_one_click' || (method === 'auto' && oneClick))
                    ? 'one_click_post'
                    : 'get';
            if (dryRun) {
                return {
                    id: messageId,
                    from,
                    subject,
                    status: 'dry_run',
                    mode: requestMode,
                    url: selectedUrl,
                };
            }
            if (requestMode === 'one_click_post') {
                const postResp = await fetch(selectedUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                    },
                    body: 'List-Unsubscribe=One-Click',
                    redirect: 'follow',
                });
                if (postResp.ok) {
                    return {
                        id: messageId,
                        from,
                        subject,
                        status: 'unsubscribed',
                        mode: 'one_click_post',
                        url: selectedUrl,
                        httpStatus: postResp.status,
                    };
                }
                if (method === 'url_one_click') {
                    return {
                        id: messageId,
                        from,
                        subject,
                        status: 'unsubscribe_failed',
                        mode: 'one_click_post',
                        url: selectedUrl,
                        httpStatus: postResp.status,
                    };
                }
            }
            const getResp = await fetch(selectedUrl, {
                method: 'GET',
                redirect: 'follow',
            });
            return {
                id: messageId,
                from,
                subject,
                status: getResp.ok ? 'unsubscribed_or_confirmation_page_opened' : 'unsubscribe_failed',
                mode: 'url_get',
                url: selectedUrl,
                httpStatus: getResp.status,
            };
        },
        // Get profile info
        get_profile: async () => {
            const response = await gmail.users.getProfile({
                userId: 'me',
            });
            return {
                emailAddress: response.data.emailAddress,
                messagesTotal: response.data.messagesTotal,
                threadsTotal: response.data.threadsTotal,
                historyId: response.data.historyId,
            };
        },
    };
}
//# sourceMappingURL=gmail.js.map