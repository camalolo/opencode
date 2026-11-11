import { google } from 'googleapis';
export function registerCalendarTools(auth) {
    const calendar = google.calendar({ version: 'v3', auth });
    return {
        // List calendars
        list_calendars: async () => {
            const response = await calendar.calendarList.list();
            return {
                calendars: response.data.items?.map(cal => ({
                    id: cal.id,
                    summary: cal.summary,
                    primary: cal.primary,
                    timeZone: cal.timeZone,
                    accessRole: cal.accessRole,
                })),
            };
        },
        // List events
        list_events: async (args) => {
            const { calendarId = 'primary', maxResults = 5, timeMin, timeMax, detail = 'summary', } = args;
            const response = await calendar.events.list({
                calendarId,
                maxResults,
                timeMin: timeMin || new Date().toISOString(),
                timeMax,
                singleEvents: true,
                orderBy: 'startTime',
            });
            return {
                mode: detail,
                events: response.data.items?.map(event => {
                    if (detail === 'full') {
                        return {
                            id: event.id,
                            summary: event.summary,
                            description: event.description,
                            location: event.location,
                            start: event.start?.dateTime || event.start?.date,
                            end: event.end?.dateTime || event.end?.date,
                            attendees: event.attendees?.map(a => ({
                                email: a.email,
                                responseStatus: a.responseStatus,
                            })),
                            htmlLink: event.htmlLink,
                        };
                    }
                    return {
                        id: event.id,
                        summary: event.summary,
                        start: event.start?.dateTime || event.start?.date,
                        end: event.end?.dateTime || event.end?.date,
                        attendees_count: event.attendees?.length || 0,
                        htmlLink: event.htmlLink,
                    };
                }),
            };
        },
        // Get event
        get_event: async (args) => {
            const { calendarId = 'primary', eventId } = args;
            const response = await calendar.events.get({
                calendarId,
                eventId,
            });
            const event = response.data;
            return {
                id: event.id,
                summary: event.summary,
                description: event.description,
                location: event.location,
                start: event.start?.dateTime || event.start?.date,
                end: event.end?.dateTime || event.end?.date,
                timeZone: event.start?.timeZone,
                attendees: event.attendees?.map(a => ({
                    email: a.email,
                    displayName: a.displayName,
                    responseStatus: a.responseStatus,
                    organizer: a.organizer,
                })),
                organizer: event.organizer,
                htmlLink: event.htmlLink,
                hangoutLink: event.hangoutLink,
                recurringEventId: event.recurringEventId,
            };
        },
        // Create event
        create_event: async (args) => {
            const { calendarId = 'primary', summary, description, location, start, end, attendees, timeZone, } = args;
            const response = await calendar.events.insert({
                calendarId,
                requestBody: {
                    summary,
                    description,
                    location,
                    start: {
                        dateTime: start,
                        timeZone,
                    },
                    end: {
                        dateTime: end,
                        timeZone,
                    },
                    attendees: attendees?.map(email => ({ email })),
                },
            });
            return {
                id: response.data.id,
                summary: response.data.summary,
                start: response.data.start?.dateTime,
                end: response.data.end?.dateTime,
                htmlLink: response.data.htmlLink,
                status: 'created',
            };
        },
        // Update event
        update_event: async (args) => {
            const { calendarId = 'primary', eventId, summary, description, location, start, end, attendees, } = args;
            // Get existing event first
            const existing = await calendar.events.get({
                calendarId,
                eventId,
            });
            const response = await calendar.events.update({
                calendarId,
                eventId,
                requestBody: {
                    ...existing.data,
                    summary: summary || existing.data.summary,
                    description: description !== undefined ? description : existing.data.description,
                    location: location !== undefined ? location : existing.data.location,
                    start: start ? { dateTime: start } : existing.data.start,
                    end: end ? { dateTime: end } : existing.data.end,
                    attendees: attendees ? attendees.map(email => ({ email })) : existing.data.attendees,
                },
            });
            return {
                id: response.data.id,
                summary: response.data.summary,
                start: response.data.start?.dateTime,
                end: response.data.end?.dateTime,
                status: 'updated',
            };
        },
        // Delete event
        delete_event: async (args) => {
            const { calendarId = 'primary', eventId } = args;
            await calendar.events.delete({
                calendarId,
                eventId,
            });
            return {
                id: eventId,
                status: 'deleted',
            };
        },
        // Find free time slots
        find_free_time: async (args) => {
            const { timeMin, timeMax, calendars = ['primary'], } = args;
            const response = await calendar.freebusy.query({
                requestBody: {
                    timeMin,
                    timeMax,
                    items: calendars.map(id => ({ id })),
                },
            });
            return {
                timeMin,
                timeMax,
                calendars: Object.entries(response.data.calendars || {}).map(([id, data]) => ({
                    calendarId: id,
                    busy: data.busy?.map(slot => ({
                        start: slot.start,
                        end: slot.end,
                    })),
                    errors: data.errors,
                })),
            };
        },
        // Quick add event (natural language)
        quick_add_event: async (args) => {
            const { calendarId = 'primary', text } = args;
            const response = await calendar.events.quickAdd({
                calendarId,
                text,
            });
            return {
                id: response.data.id,
                summary: response.data.summary,
                start: response.data.start?.dateTime || response.data.start?.date,
                end: response.data.end?.dateTime || response.data.end?.date,
                htmlLink: response.data.htmlLink,
                status: 'created',
            };
        },
    };
}
//# sourceMappingURL=calendar.js.map