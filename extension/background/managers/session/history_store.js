export async function getHistory(sessionId) {
    if (!sessionId) return [];
    try {
        const { geminiSessions } = await chrome.storage.local.get(['geminiSessions']);
        const session = geminiSessions
            ? geminiSessions.find((storedSession) => storedSession.id === sessionId)
            : null;
        if (session && session.messages) {
            return session.messages;
        }
        return [];
    } catch (error) {
        console.warn('Failed to read history from chrome.storage:', error);
        return [];
    }
}
