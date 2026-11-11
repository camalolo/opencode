import { google } from 'googleapis';
export function registerDocsTools(auth) {
    const docs = google.docs({ version: 'v1', auth });
    return {
        list_doc_structure: async (args) => {
            const { documentId } = args;
            const response = await docs.documents.get({ documentId });
            const body = response.data.body?.content || [];
            return {
                documentId: response.data.documentId,
                title: response.data.title,
                elementCount: body.length,
                elements: body.map((el, idx) => ({
                    index: idx,
                    type: el.paragraph
                        ? 'paragraph'
                        : el.table
                            ? 'table'
                            : el.sectionBreak
                                ? 'sectionBreak'
                                : 'other',
                    startIndex: el.startIndex,
                    endIndex: el.endIndex,
                })),
            };
        },
        read_doc_text: async (args) => {
            const { documentId } = args;
            const response = await docs.documents.get({ documentId });
            const content = response.data.body?.content || [];
            let text = '';
            for (const element of content) {
                const paragraph = element.paragraph;
                if (!paragraph?.elements)
                    continue;
                for (const pEl of paragraph.elements) {
                    const t = pEl.textRun?.content;
                    if (t)
                        text += t;
                }
            }
            return {
                documentId: response.data.documentId,
                title: response.data.title,
                text: text.trim(),
            };
        },
        create_doc: async (args) => {
            const { title, content } = args;
            const created = await docs.documents.create({
                requestBody: { title },
            });
            const documentId = created.data.documentId;
            if (content) {
                await docs.documents.batchUpdate({
                    documentId,
                    requestBody: {
                        requests: [
                            {
                                insertText: {
                                    location: { index: 1 },
                                    text: content,
                                },
                            },
                        ],
                    },
                });
            }
            return {
                documentId,
                title: created.data.title,
                status: 'created',
            };
        },
        append_doc_text: async (args) => {
            const { documentId, text } = args;
            const current = await docs.documents.get({ documentId });
            const endIndex = Math.max(1, (current.data.body?.content?.at(-1)?.endIndex || 1) - 1);
            await docs.documents.batchUpdate({
                documentId,
                requestBody: {
                    requests: [
                        {
                            insertText: {
                                location: { index: endIndex },
                                text,
                            },
                        },
                    ],
                },
            });
            return { documentId, status: 'appended' };
        },
    };
}
//# sourceMappingURL=docs.js.map