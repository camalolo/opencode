import { google } from 'googleapis';
export function registerPeopleTools(auth) {
    const people = google.people({ version: 'v1', auth });
    return {
        list_contacts: async (args) => {
            const { pageSize = 50, pageToken } = args;
            const response = await people.people.connections.list({
                resourceName: 'people/me',
                pageSize,
                pageToken,
                personFields: 'names,emailAddresses,phoneNumbers,organizations',
            });
            return {
                nextPageToken: response.data.nextPageToken,
                totalPeople: response.data.totalPeople,
                totalItems: response.data.totalItems,
                contacts: response.data.connections?.map((p) => ({
                    resourceName: p.resourceName,
                    etag: p.etag,
                    names: p.names?.map((n) => n.displayName),
                    emailAddresses: p.emailAddresses?.map((e) => e.value),
                    phoneNumbers: p.phoneNumbers?.map((ph) => ph.value),
                    organizations: p.organizations?.map((o) => o.name),
                })),
            };
        },
        search_contacts: async (args) => {
            const { query, pageSize = 20 } = args;
            const response = await people.people.searchContacts({
                query,
                pageSize,
                readMask: 'names,emailAddresses,phoneNumbers,organizations',
            });
            return {
                results: response.data.results?.map((r) => ({
                    resourceName: r.person?.resourceName,
                    names: r.person?.names?.map((n) => n.displayName),
                    emailAddresses: r.person?.emailAddresses?.map((e) => e.value),
                    phoneNumbers: r.person?.phoneNumbers?.map((ph) => ph.value),
                })),
            };
        },
        create_contact: async (args) => {
            const { givenName, familyName, email, phone, company } = args;
            const response = await people.people.createContact({
                requestBody: {
                    names: [{ givenName, familyName }],
                    emailAddresses: email ? [{ value: email }] : undefined,
                    phoneNumbers: phone ? [{ value: phone }] : undefined,
                    organizations: company ? [{ name: company }] : undefined,
                },
            });
            return {
                resourceName: response.data.resourceName,
                etag: response.data.etag,
                status: 'created',
            };
        },
        get_contact: async (args) => {
            const { resourceName } = args;
            const response = await people.people.get({
                resourceName,
                personFields: 'names,emailAddresses,phoneNumbers,organizations,biographies',
            });
            return {
                resourceName: response.data.resourceName,
                etag: response.data.etag,
                names: response.data.names?.map((n) => n.displayName),
                emailAddresses: response.data.emailAddresses?.map((e) => e.value),
                phoneNumbers: response.data.phoneNumbers?.map((ph) => ph.value),
                organizations: response.data.organizations?.map((o) => o.name),
            };
        },
    };
}
//# sourceMappingURL=people.js.map