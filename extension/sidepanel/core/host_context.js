export function publishHostContext(frame, getIsRunningInTab) {
    return getIsRunningInTab()
        .then((isTab) => {
            frame.postMessage({
                action: 'SET_HOST_CONTEXT',
                payload: { isTab },
            });
        })
        .catch(() => {
            frame.postMessage({
                action: 'SET_HOST_CONTEXT',
                payload: { isTab: false },
            });
        });
}
