import { google } from 'googleapis';
export function registerSlidesTools(auth) {
    const slides = google.slides({ version: 'v1', auth });
    return {
        get_presentation: async (args) => {
            const { presentationId } = args;
            const response = await slides.presentations.get({ presentationId });
            return {
                presentationId: response.data.presentationId,
                title: response.data.title,
                slideCount: response.data.slides?.length || 0,
                slides: response.data.slides?.map((s, idx) => ({
                    index: idx,
                    objectId: s.objectId,
                    elementCount: s.pageElements?.length || 0,
                })),
            };
        },
        create_presentation: async (args) => {
            const { title } = args;
            const response = await slides.presentations.create({
                requestBody: { title },
            });
            return {
                presentationId: response.data.presentationId,
                title: response.data.title,
                status: 'created',
            };
        },
        create_slide: async (args) => {
            const { presentationId, layout = 'TITLE_AND_BODY' } = args;
            const response = await slides.presentations.batchUpdate({
                presentationId,
                requestBody: {
                    requests: [
                        {
                            createSlide: {
                                slideLayoutReference: {
                                    predefinedLayout: layout,
                                },
                            },
                        },
                    ],
                },
            });
            return {
                presentationId,
                replies: response.data.replies,
                status: 'slide_created',
            };
        },
    };
}
//# sourceMappingURL=slides.js.map