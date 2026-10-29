import { normalizeMcpHeaders } from '../../../../shared/mcp/transport.js';

export function formatMcpHeaders(headers) {
    const normalized = normalizeMcpHeaders(headers);
    if (Object.keys(normalized).length === 0) return '';
    return JSON.stringify(normalized, null, 2);
}

export function parseMcpHeadersText(text) {
    const raw = (text || '').trim();
    if (!raw) return {};

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('Request headers must be valid JSON.');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Request headers must be a JSON object.');
    }

    return normalizeMcpHeaders(parsed);
}
