import { BaseActionHandler } from '../base.js';

export class FileActions extends BaseActionHandler {
    async attachFile({ uid, paths }) {
        if (!paths || !Array.isArray(paths) || paths.length === 0) {
            return "Error: 'paths' must be a non-empty array of strings.";
        }

        const backendNodeId = this.snapshotManager.getBackendNodeId(uid);
        if (!backendNodeId) return `Error: UID ${uid} not found. Call take_snapshot first.`;

        // Audit log: attach_file reads arbitrary local file paths, so record what
        // the agent requested for traceability without blocking legitimate uploads.
        console.warn(`[Browser Control] attach_file invoked by agent — uid=${uid}, paths=`, paths);

        await this.moveCursorToElement({ backendNodeId });

        await this.cmd('DOM.enable');

        try {
            await this.waitHelper.execute(async () => {
                await this.cmd('DOM.setFileInputFiles', {
                    files: paths,
                    backendNodeId,
                });
            });
            return `Successfully attached ${paths.length} files to element ${uid}.`;
        } catch (error) {
            return `Error attaching files: ${error.message}`;
        }
    }
}
