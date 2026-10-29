export function hasRenderedToolOutput(historyDiv, key) {
    if (!historyDiv || !key) return false;
    return Array.from(historyDiv.querySelectorAll('[data-tool-output-key]')).some(
        (element) => element.dataset.toolOutputKey === key
    );
}

export function findRenderedToolStatus(historyDiv, key) {
    if (!historyDiv || !key) return null;
    const element = Array.from(historyDiv.querySelectorAll('[data-tool-status-key]')).find(
        (candidate) => candidate.dataset.toolStatusKey === key
    );
    return element?.__messageController || null;
}

export function removeRenderedToolStatus(historyDiv, key) {
    const controller = findRenderedToolStatus(historyDiv, key);
    if (!controller) return;
    if (typeof controller.dispose === 'function') {
        controller.dispose();
    }
    if (controller.div && typeof controller.div.remove === 'function') {
        controller.div.remove();
    }
}
