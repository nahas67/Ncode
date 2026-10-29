import { describe, expect, it } from 'vitest';
import { normalizeMcpHeaders } from '../../../../shared/mcp/transport.js';
import { formatMcpHeaders, parseMcpHeadersText } from './mcp_header_fields.js';

describe('MCP header field helpers', () => {
    it('normalizes MCP headers to trimmed string key-value pairs', () => {
        expect(
            normalizeMcpHeaders({
                ' Authorization ': ' Bearer token ',
                Empty: ' ',
                Missing: null,
            })
        ).toEqual({
            Authorization: 'Bearer token',
        });
    });

    it('formats and parses MCP header JSON', () => {
        const formatted = formatMcpHeaders({ Authorization: 'Bearer token' });

        expect(formatted).toBe('{\n  "Authorization": "Bearer token"\n}');
        expect(parseMcpHeadersText(formatted)).toEqual({ Authorization: 'Bearer token' });
        expect(parseMcpHeadersText('')).toEqual({});
        expect(() => parseMcpHeadersText('[]')).toThrow('Request headers must be a JSON object.');
    });
});
