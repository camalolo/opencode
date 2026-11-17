import { google } from 'googleapis';
const spaceName = (space) => (space.startsWith('spaces/') ? space : `spaces/${space}`);
const threadName = (space, thread) => {
    if (!thread) return undefined;
    if (thread.startsWith('spaces/')) return thread;
    return `${spaceName(space)}/threads/${thread}`;
};
const messageName = (message) => (message.includes('/messages/') ? message : null);
function formatSpace(space) {
    return {
        name: space.name,
        displayName: space.displayName ?? null,
        spaceType: space.spaceType ?? null,
        spaceUri: space.spaceUri ?? null,
        createTime: space.createTime ?? null,
        lastActiveTime: space.lastActiveTime ?? null,
        membershipCount: space.membershipCount ?? null,
        spaceDetails: space.spaceDetails ?? null,
        singleUserBotDm: space.singleUserBotDm ?? null,
        externalUserAllowed: space.externalUserAllowed ?? null,
    };
}
function formatMessage(message, fallbackSpace) {
    return {
        name: message.name,
        space: message.space?.name ?? fallbackSpace ?? null,
        createTime: message.createTime ?? null,
        lastUpdateTime: message.lastUpdateTime ?? null,
        sender: message.sender
            ? { name: message.sender.name, displayName: message.sender.displayName, type: message.sender.type }
            : null,
        text: message.text ?? null,
        argumentText: message.argumentText ?? null,
        thread: message.thread?.name ?? null,
        threadReply: message.threadReply ?? null,
        deleted: Boolean(message.deletionMetadata) || Boolean(message.deleteTime),
        attachments: (message.attachment ?? []).map((attachment) => ({
            name: attachment.name,
            contentName: attachment.contentName,
            contentType: attachment.contentType,
            source: attachment.source,
            driveFileId: attachment.driveDataRef?.driveFileResourceName ?? null,
            downloadUri: attachment.downloadUri ?? null,
            thumbnailUri: attachment.thumbnailUri ?? null,
        })),
    };
}
async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index]);
        }
    });
    await Promise.all(workers);
    return results;
}
export function registerChatTools(auth) {
    const chat = google.chat({ version: 'v1', auth });
    // DM spaces carry no peer name; resolve it from the membership list by
    // dropping the user's own membership. people/me would identify the user but
    // needs the OIDC profile scope, which we don't hold (and shouldn't force a
    // re-consent for a label), so the Chat member API's email alias does it:
    // Gmail profile gives the address, members.get on a space the user is in
    // resolves it to users/{id}. Best-effort: an unresolvable peer must not hide
    // the space itself.
    let selfUserIdPromise = null;
    const selfUserId = (space) => {
        if (!selfUserIdPromise) {
            const gmail = google.gmail({ version: 'v1', auth });
            selfUserIdPromise = (async () => {
                const profile = await gmail.users.getProfile({ userId: 'me' });
                const response = await chat.spaces.members.get({
                    name: `${space}/members/${profile.data.emailAddress}`,
                });
                return response.data.member?.name ?? null;
            })().catch(() => null);
        }
        return selfUserIdPromise;
    };
    const dmPeer = async (space) => {
        if (space.spaceType !== 'DIRECT_MESSAGE') return null;
        const self = await selfUserId(space.name);
        const response = await chat.spaces.members.list({ parent: space.name, pageSize: 10 });
        const peers = (response.data.memberships ?? [])
            .map((membership) => membership.member)
            .filter((member) => member && member.type !== 'BOT' && member.name !== self)
            .map((member) => member.displayName)
            .filter(Boolean);
        return peers.length ? peers.join(', ') : null;
    };
    return {
        list_spaces: async (args) => {
            const { pageSize = 100, pageToken, filter, includeDmPeers = true } = args;
            const response = await chat.spaces.list({ pageSize, pageToken, filter });
            const spaces = response.data.spaces ?? [];
            const peers = includeDmPeers
                ? await mapWithConcurrency(spaces, 8, (space) => dmPeer(space))
                : spaces.map(() => null);
            return {
                nextPageToken: response.data.nextPageToken,
                spaces: spaces.map((space, index) => ({
                    ...formatSpace(space),
                    dmPeer: peers[index] ?? null,
                })),
            };
        },
        get_space: async (args) => {
            const response = await chat.spaces.get({ name: spaceName(args.space) });
            return {
                ...formatSpace(response.data),
                dmPeer: await dmPeer(response.data),
            };
        },
        list_messages: async (args) => {
            const { space, pageSize = 50, pageToken, order = 'desc', since, until, thread, showDeleted = false } = args;
            const parent = spaceName(space);
            const conditions = [];
            if (since) conditions.push(`create_time > "${since}"`);
            if (until) conditions.push(`create_time < "${until}"`);
            if (thread) conditions.push(`thread.name = ${threadName(parent, thread)}`);
            const response = await chat.spaces.messages.list({
                parent,
                pageSize,
                pageToken,
                // The API rejects a bare ASC/DESC here; it wants the attribute.
                orderBy: order.toLowerCase() === 'asc' ? 'createTime ASC' : 'createTime DESC',
                filter: conditions.length ? conditions.join(' AND ') : undefined,
                showDeleted,
            });
            return {
                nextPageToken: response.data.nextPageToken,
                messages: (response.data.messages ?? []).map((message) => formatMessage(message, parent)),
            };
        },
        get_message: async (args) => {
            const name = messageName(args.name);
            if (!name) {
                throw new Error('name must be a full message resource name: spaces/{space}/messages/{message}');
            }
            const response = await chat.spaces.messages.get({ name });
            return formatMessage(response.data);
        },
        send_message: async (args) => {
            const { space, text, thread } = args;
            const parent = spaceName(space);
            const threadResource = threadName(parent, thread);
            const response = await chat.spaces.messages.create({
                parent,
                messageReplyOption: threadResource ? 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' : undefined,
                requestBody: {
                    text,
                    thread: threadResource ? { name: threadResource } : undefined,
                },
            });
            return formatMessage(response.data, parent);
        },
        list_members: async (args) => {
            const { space, pageSize = 100, pageToken, filter, showGroups = false, showInvited = false } = args;
            const response = await chat.spaces.members.list({
                parent: spaceName(space),
                pageSize,
                pageToken,
                filter,
                showGroups,
                showInvited,
            });
            return {
                nextPageToken: response.data.nextPageToken,
                members: (response.data.memberships ?? []).map((membership) => ({
                    name: membership.name,
                    role: membership.role,
                    state: membership.state ?? null,
                    createTime: membership.createTime ?? null,
                    member: membership.member
                        ? { name: membership.member.name, displayName: membership.member.displayName, type: membership.member.type }
                        : null,
                    groupMember: membership.groupMember
                        ? { name: membership.groupMember.name, displayName: membership.groupMember.displayName ?? null }
                        : null,
                })),
            };
        },
    };
}
//# sourceMappingURL=chat.js.map
