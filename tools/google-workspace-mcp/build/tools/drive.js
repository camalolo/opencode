import { google } from 'googleapis';
export function registerDriveTools(auth) {
    const drive = google.drive({ version: 'v3', auth });
    return {
        // List files
        list_files: async (args) => {
            const { query, maxResults = 5, orderBy = 'modifiedTime desc', detail = 'summary' } = args;
            const response = await drive.files.list({
                q: query,
                pageSize: maxResults,
                orderBy,
                fields: 'files(id, name, mimeType, size, createdTime, modifiedTime, webViewLink, owners)',
            });
            return {
                mode: detail,
                files: response.data.files?.map(file => {
                    if (detail === 'full') {
                        return {
                            id: file.id,
                            name: file.name,
                            mimeType: file.mimeType,
                            size: file.size,
                            createdTime: file.createdTime,
                            modifiedTime: file.modifiedTime,
                            webViewLink: file.webViewLink,
                            owners: file.owners?.map(o => o.emailAddress),
                        };
                    }
                    return {
                        id: file.id,
                        name: file.name,
                        mimeType: file.mimeType,
                        modifiedTime: file.modifiedTime,
                        webViewLink: file.webViewLink,
                    };
                }),
            };
        },
        // Get file metadata
        get_file: async (args) => {
            const { fileId } = args;
            const response = await drive.files.get({
                fileId,
                fields: 'id, name, mimeType, size, createdTime, modifiedTime, webViewLink, webContentLink, owners, permissions, parents, shared',
            });
            return {
                id: response.data.id,
                name: response.data.name,
                mimeType: response.data.mimeType,
                size: response.data.size,
                createdTime: response.data.createdTime,
                modifiedTime: response.data.modifiedTime,
                webViewLink: response.data.webViewLink,
                webContentLink: response.data.webContentLink,
                owners: response.data.owners?.map(o => o.emailAddress),
                parents: response.data.parents,
                shared: response.data.shared,
            };
        },
        // Search files
        search_files: async (args) => {
            const { query, maxResults = 20 } = args;
            const response = await drive.files.list({
                q: `fullText contains '${query}' or name contains '${query}'`,
                pageSize: maxResults,
                orderBy: 'modifiedTime desc',
                fields: 'files(id, name, mimeType, size, modifiedTime, webViewLink)',
            });
            return {
                count: response.data.files?.length || 0,
                files: response.data.files?.map(file => ({
                    id: file.id,
                    name: file.name,
                    mimeType: file.mimeType,
                    size: file.size,
                    modifiedTime: file.modifiedTime,
                    webViewLink: file.webViewLink,
                })),
            };
        },
        // Create folder
        create_folder: async (args) => {
            const { name, parentId } = args;
            const response = await drive.files.create({
                requestBody: {
                    name,
                    mimeType: 'application/vnd.google-apps.folder',
                    parents: parentId ? [parentId] : undefined,
                },
                fields: 'id, name, webViewLink',
            });
            return {
                id: response.data.id,
                name: response.data.name,
                webViewLink: response.data.webViewLink,
                status: 'created',
            };
        },
        // Delete file
        delete_file: async (args) => {
            const { fileId } = args;
            await drive.files.delete({
                fileId,
            });
            return {
                id: fileId,
                status: 'deleted',
            };
        },
        // Copy file
        copy_file: async (args) => {
            const { fileId, name, parentId } = args;
            const response = await drive.files.copy({
                fileId,
                requestBody: {
                    name,
                    parents: parentId ? [parentId] : undefined,
                },
                fields: 'id, name, webViewLink',
            });
            return {
                id: response.data.id,
                name: response.data.name,
                webViewLink: response.data.webViewLink,
                status: 'copied',
            };
        },
        // Move file
        move_file: async (args) => {
            const { fileId, newParentId } = args;
            // Get current parents
            const file = await drive.files.get({
                fileId,
                fields: 'parents',
            });
            const previousParents = file.data.parents?.join(',');
            const response = await drive.files.update({
                fileId,
                addParents: newParentId,
                removeParents: previousParents,
                fields: 'id, name, parents',
            });
            return {
                id: response.data.id,
                name: response.data.name,
                parents: response.data.parents,
                status: 'moved',
            };
        },
        // Share file
        share_file: async (args) => {
            const { fileId, email, role = 'reader', sendNotification = true, } = args;
            const response = await drive.permissions.create({
                fileId,
                sendNotificationEmail: sendNotification,
                requestBody: {
                    type: 'user',
                    role,
                    emailAddress: email,
                },
                fields: 'id',
            });
            return {
                fileId,
                permissionId: response.data.id,
                email,
                role,
                status: 'shared',
            };
        },
        // Get file content (for text files)
        get_file_content: async (args) => {
            const { fileId, mimeType } = args;
            const response = await drive.files.get({
                fileId,
                alt: 'media',
            }, {
                responseType: 'text',
            });
            return {
                fileId,
                content: response.data,
            };
        },
        // Export Google Doc/Sheet/Slides
        export_file: async (args) => {
            const { fileId, mimeType } = args;
            const response = await drive.files.export({
                fileId,
                mimeType,
            }, {
                responseType: 'text',
            });
            return {
                fileId,
                mimeType,
                content: response.data,
            };
        },
        // Get storage quota
        get_storage_quota: async () => {
            const response = await drive.about.get({
                fields: 'storageQuota, user',
            });
            const quota = response.data.storageQuota;
            return {
                user: response.data.user?.emailAddress,
                limit: quota?.limit,
                usage: quota?.usage,
                usageInDrive: quota?.usageInDrive,
                usageInDriveTrash: quota?.usageInDriveTrash,
            };
        },
    };
}
//# sourceMappingURL=drive.js.map