import { BaseActionHandler } from '../base.js';
import { ScriptEvaluationActions } from './script_evaluation.js';
import { WaitActions } from './wait.js';
import { DialogActions } from './dialog.js';
import { ScreenshotActions } from './screenshot.js';
import { DownloadActions } from './downloads.js';

export class ObservationActions extends BaseActionHandler {
    constructor(connection, snapshotManager, waitHelper) {
        super(connection, snapshotManager, waitHelper);

        this.script = new ScriptEvaluationActions(connection, snapshotManager, waitHelper);
        this.wait = new WaitActions(connection, snapshotManager, waitHelper);
        this.dialog = new DialogActions(connection, snapshotManager, waitHelper);
        this.screenshot = new ScreenshotActions(connection, snapshotManager, waitHelper);
        this.downloads = new DownloadActions();
    }

    async waitFor(args) {
        return this.wait.waitFor(args);
    }

    async waitForUrl(args) {
        return this.wait.waitForUrl(args);
    }

    async waitForLoadState(args) {
        return this.wait.waitForLoadState(args);
    }

    async waitForTimeout(args) {
        return this.wait.waitForTimeout(args);
    }

    async takeScreenshot(args) {
        return this.screenshot.takeScreenshot(args);
    }

    async evaluateScript(args) {
        return this.script.evaluateScript(args);
    }

    async handleDialog(args) {
        return this.dialog.handleDialog(args);
    }

    async listDownloads(args) {
        return this.downloads.listDownloads(args);
    }

    async waitForDownload(args) {
        return this.downloads.waitForDownload(args);
    }
}
