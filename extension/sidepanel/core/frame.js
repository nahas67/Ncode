export class FrameManager {
    constructor() {
        this.iframe = document.getElementById('sandbox-frame');
        this.skeleton = document.getElementById('skeleton');
    }

    init() {
        // Read cached shell preferences synchronously before the iframe loads.
        const cachedTheme = localStorage.getItem('geminiTheme') || 'system';
        const cachedLang = localStorage.getItem('geminiLanguage') || 'system';
        const cachedSidebarExpanded = localStorage.getItem('geminiSidebarExpanded');

        const params = new URLSearchParams({
            theme: cachedTheme,
            lang: cachedLang,
        });

        if (cachedSidebarExpanded === 'true' || cachedSidebarExpanded === 'false') {
            params.set('sidebarExpanded', cachedSidebarExpanded);
        }

        const sandboxPath = `sandbox/index.html?${params.toString()}`;
        const runtime = globalThis.chrome && globalThis.chrome.runtime;

        // Set an absolute extension URL to avoid relative-frame navigation errors.
        if (runtime && typeof runtime.getURL === 'function') {
            this.iframe.src = runtime.getURL(sandboxPath);
            return;
        }

        this.iframe.src = new URL(`../${sandboxPath}`, window.location.href).toString();
    }

    reveal() {
        this.iframe.classList.add('loaded');
        if (this.skeleton) this.skeleton.classList.add('hidden');
    }

    postMessage(message) {
        if (!this.iframe.contentWindow) return;

        // Manifest `sandbox.pages` iframes have an opaque origin. Chrome rejects
        // targetOrigin 'null' with:
        //   SyntaxError: Invalid target origin 'null' in a call to 'postMessage'
        // and silently drops messages when targetOrigin is chrome-extension://<id>
        // (does not match the opaque origin). Wildcard '*' is required here.
        // This is not a broadcast: the message is only delivered to this
        // contentWindow. Sandbox → parent already uses '*' for the same reason
        // (see shared/messaging).
        this.iframe.contentWindow.postMessage(message, '*');
    }

    getWindow() {
        return this.iframe.contentWindow;
    }

    isWindow(sourceWindow) {
        return this.iframe.contentWindow && sourceWindow === this.iframe.contentWindow;
    }
}
