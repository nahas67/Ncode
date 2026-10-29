export function formatLogDownloadText(logs) {
    return logs
        .map((log) => {
            const time = new Date(log.timestamp).toISOString();
            const dataStr = log.data ? ` | Data: ${JSON.stringify(log.data)}` : '';
            return `[${time}] [${log.level}] [${log.context}] ${log.message}${dataStr}`;
        })
        .join('\n');
}
