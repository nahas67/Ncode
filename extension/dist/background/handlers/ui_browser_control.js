export function handleToggleBrowserControl(context, request, sender, sendResponse) {
    const createDisabledErrorResponse = () => ({
        status: 'error',
        error: context.controlManager?.lastControlError || 'Browser control could not be enabled.',
    });

    try {
        let controlResult;
        let initialCreateForRetry = false;
        if (context.controlManager) {
            const targetSidePanelTabId = context.getTargetSidePanelTabId(request, sender);
            context.controlManager.setOwnerSidePanelTabId?.(targetSidePanelTabId);
            if (request.enabled) {
                const createDefaultTab = request.hostIsTab === true && !targetSidePanelTabId;
                initialCreateForRetry = createDefaultTab === true;
                controlResult = context.controlManager.enableControl({
                    createDefaultTab,
                });
            } else {
                controlResult = context.controlManager.disableControl();
            }
        }

        if (controlResult && typeof controlResult.then === 'function') {
            controlResult
                .then(async (result) => {
                    if (request.enabled && result === false && !initialCreateForRetry) {
                        try {
                            const retryResult = await context.controlManager.enableControl({
                                createDefaultTab: true,
                            });
                            if (retryResult) {
                                sendResponse({ status: 'processed' });
                                return;
                            }
                        } catch (retryError) {
                            console.warn(
                                '[ui_browser_control] retry with new tab failed',
                                retryError
                            );
                        }
                    }
                    if (request.enabled && result === false) {
                        sendResponse(createDisabledErrorResponse());
                        return;
                    }
                    sendResponse({ status: 'processed' });
                })
                .catch((error) => {
                    console.error('Browser control toggle failed', error);
                    sendResponse({ status: 'error', error: error?.message || String(error) });
                });
        } else if (request.enabled && controlResult === false) {
            sendResponse(createDisabledErrorResponse());
        } else {
            sendResponse({ status: 'processed' });
        }
    } catch (error) {
        console.error('Browser control toggle failed', error);
        sendResponse({ status: 'error', error: error?.message || String(error) });
    }
}
