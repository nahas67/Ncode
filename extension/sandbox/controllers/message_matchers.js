function normalizeListValue(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
        return value.url || value.title || JSON.stringify(value);
    }
    return '';
}

function normalizeList(values) {
    return Array.isArray(values) ? values.map(normalizeListValue).filter(Boolean) : [];
}

function listsMatch(expectedValues, actualValues) {
    const expected = normalizeList(expectedValues);
    if (expected.length === 0) return false;
    const actual = normalizeList(actualValues);
    return (
        expected.length === actual.length &&
        expected.every((value, index) => value === actual[index])
    );
}

export function hasMatchingReplyMedia(lastMessage, request) {
    return (
        listsMatch(request.images, lastMessage.generatedImages) ||
        listsMatch(request.sources, lastMessage.sources)
    );
}
