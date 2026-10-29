/**
 * Shared provider utilities for URL handling
 */

/**
 * Normalize base URL by removing trailing slash
 */
export function normalizeBaseUrl(baseUrl) {
    return String(baseUrl || '').replace(/\/$/, '');
}

/**
 * Extract the base64 payload from a data URL
 */
export function getDataUrlPayload(dataUrl) {
    if (typeof dataUrl !== 'string') return '';
    const commaIndex = dataUrl.indexOf(',');
    return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : '';
}
