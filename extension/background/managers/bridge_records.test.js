import { describe, expect, it, vi } from 'vitest';
import {
    createBridgeRecordHandlers,
    projectSession,
    redactLargeBlobs,
    selectSessions,
    summarizeSession,
} from './bridge_records.js';

const sampleSessions = [
    {
        id: 's1',
        title: 'Hello world',
        timestamp: 1000,
        messages: [
            { role: 'user', text: 'Hello world', image: ['data:image/png;base64,AAAA'] },
            {
                role: 'ai',
                text: 'Hi there',
                thoughts: 'thinking…',
                officialContent: {
                    role: 'model',
                    parts: [{ functionCall: { name: 'click_element', args: { uid: '2_15' } } }],
                },
            },
        ],
        context: { foo: 1 },
    },
    {
        id: 's2',
        title: 'Browser task',
        timestamp: 2000,
        messages: [
            { role: 'user', text: 'Open settings page please' },
            { role: 'ai', text: 'Done.' },
        ],
    },
];

describe('redactLargeBlobs', () => {
    it('redacts data URLs by default', () => {
        const out = redactLargeBlobs({ image: 'data:image/png;base64,AAAA' });
        expect(out.image).toMatch(/omitted base64/);
    });

    it('keeps blobs when includeAttachments is true', () => {
        const raw = 'data:image/png;base64,AAAA';
        expect(redactLargeBlobs(raw, { includeAttachments: true })).toBe(raw);
    });
});

describe('summarizeSession / projectSession / selectSessions', () => {
    it('summarizes without full messages by default', () => {
        const s = summarizeSession(sampleSessions[0]);
        expect(s.id).toBe('s1');
        expect(s.messageCount).toBe(2);
        expect(s.userPreview).toContain('Hello');
        expect(s.messages).toBeUndefined();
    });

    it('projects full session with redacted attachments', () => {
        const full = projectSession(sampleSessions[0]);
        expect(full.messages[0].text).toBe('Hello world');
        expect(full.messages[0].image[0]).toMatch(/omitted base64/);
        expect(full.messages[1].officialContent.parts[0].functionCall.name).toBe('click_element');
    });

    it('filters by query and paginates', () => {
        const result = selectSessions(sampleSessions, { query: 'browser', limit: 10 });
        expect(result.total).toBe(1);
        expect(result.sessions[0].id).toBe('s2');
    });

    it('returns full messages when id is set', () => {
        const result = selectSessions(sampleSessions, { id: 's1' });
        expect(result.sessions[0].messages).toHaveLength(2);
    });
});

describe('createBridgeRecordHandlers', () => {
    function makeStorage(data) {
        return {
            get: vi.fn(async (keys) => {
                if (keys == null) return { ...data };
                if (Array.isArray(keys)) {
                    const out = {};
                    for (const k of keys) out[k] = data[k];
                    return out;
                }
                return data;
            }),
        };
    }

    it('get_session returns found session', async () => {
        const handlers = createBridgeRecordHandlers({
            storageLocal: makeStorage({ geminiSessions: sampleSessions }),
            getLogs: () => [{ message: 'log1' }],
        });
        const result = await handlers.get_session({ id: 's1' });
        expect(result.found).toBe(true);
        expect(result.session.messages[1].text).toBe('Hi there');
    });

    it('get_session requires id', async () => {
        const handlers = createBridgeRecordHandlers({
            storageLocal: makeStorage({ geminiSessions: sampleSessions }),
        });
        await expect(handlers.get_session({})).rejects.toThrow(/id required/);
    });

    it('get_records includes sessions groups and logs', async () => {
        const handlers = createBridgeRecordHandlers({
            storageLocal: makeStorage({
                geminiSessions: sampleSessions,
                geminiGroups: [{ id: 'g1', name: 'Work' }],
            }),
            getLogs: () => [{ level: 'INFO', message: 'hi' }],
        });
        const result = await handlers.get_records({ limit: 10 });
        expect(result.sessions.total).toBe(2);
        expect(result.sessions.sessions[0].messages).toBeDefined();
        expect(result.groups).toEqual([{ id: 'g1', name: 'Work' }]);
        expect(result.logs).toHaveLength(1);
    });

    it('get_storage_keys lists keys with sizes', async () => {
        const handlers = createBridgeRecordHandlers({
            storageLocal: makeStorage({ geminiSessions: sampleSessions, foo: 1 }),
        });
        const result = await handlers.get_storage_keys();
        expect(result.keys).toContain('geminiSessions');
        expect(result.sizes.geminiSessions).toBeGreaterThan(0);
    });
});
