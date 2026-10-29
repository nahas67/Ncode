export async function copyToClipboard(text) {
    // Detect if we are in a sandboxed iframe with opaque origin (null).
    // In this case, navigator.clipboard.writeText triggers a Permissions Policy violation
    // even with allow="clipboard-write", so we skip it to avoid the console error.
    const isSandboxed = window.origin === 'null';

    // Try the modern API first when the iframe is allowed to use it.
    if (!isSandboxed && navigator.clipboard && navigator.clipboard.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch (error) {
            console.warn(
                'Clipboard API failed (likely permissions), attempting fallback...',
                error
            );
        }
    }

    // This usually works in sandboxed iframes or contexts where the Async API is blocked.
    const textArea = document.createElement('textarea');
    textArea.value = text;

    // Keep it in the DOM for execCommand while remaining invisible.
    textArea.className = 'clipboard-staging-input';
    document.body.appendChild(textArea);

    textArea.focus();
    textArea.select();

    try {
        const successful = document.execCommand('copy');
        if (!successful) throw new Error('execCommand returned false');
    } catch (error) {
        throw new Error('Fallback copy failed: ' + error.message);
    } finally {
        document.body.removeChild(textArea);
    }
}
