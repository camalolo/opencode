import { google } from 'googleapis';
export function registerSheetsTools(auth) {
    const sheets = google.sheets({ version: 'v4', auth });
    return {
        get_sheet_values: async (args) => {
            const { spreadsheetId, range } = args;
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId,
                range,
            });
            return {
                range: response.data.range,
                majorDimension: response.data.majorDimension,
                values: response.data.values || [],
            };
        },
        update_sheet_values: async (args) => {
            const { spreadsheetId, range, values, valueInputOption = 'USER_ENTERED' } = args;
            const response = await sheets.spreadsheets.values.update({
                spreadsheetId,
                range,
                valueInputOption,
                requestBody: { values },
            });
            return {
                updatedRange: response.data.updatedRange,
                updatedRows: response.data.updatedRows,
                updatedColumns: response.data.updatedColumns,
                updatedCells: response.data.updatedCells,
            };
        },
        append_sheet_values: async (args) => {
            const { spreadsheetId, range, values, valueInputOption = 'USER_ENTERED' } = args;
            const response = await sheets.spreadsheets.values.append({
                spreadsheetId,
                range,
                valueInputOption,
                requestBody: { values },
            });
            return {
                tableRange: response.data.tableRange,
                updates: response.data.updates,
            };
        },
        create_spreadsheet: async (args) => {
            const { title, sheetTitle = 'Sheet1' } = args;
            const response = await sheets.spreadsheets.create({
                requestBody: {
                    properties: { title },
                    sheets: [{ properties: { title: sheetTitle } }],
                },
            });
            return {
                spreadsheetId: response.data.spreadsheetId,
                spreadsheetUrl: response.data.spreadsheetUrl,
                title: response.data.properties?.title,
            };
        },
    };
}
//# sourceMappingURL=sheets.js.map