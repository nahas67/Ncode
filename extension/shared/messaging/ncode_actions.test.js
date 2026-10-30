import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    NCODE_ACTION_NAMES,
    NCODE_ACTIONS,
    NCODE_LEGACY_ACTION_ALIASES,
    broadcastNcodeAction,
    canonicalNcodeAction,
    isNcodeAction,
    legacyAliasesFor,
} from './ncode_actions.js';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('canonical Ncode harness actions', () => {
    it('exposes the full UI message contract', () => {
        expect(NCODE_ACTIONS).toMatchObject({
            GET_HARNESS_STATUS: 'NCODE_GET_HARNESS_STATUS',
            HARNESS_STATUS_UPDATE: 'NCODE_HARNESS_STATUS_UPDATE',
            TRIGGER_COMPACT_RESUME: 'NCODE_TRIGGER_COMPACT_RESUME',
            GOAL_STATE_UPDATE: 'NCODE_GOAL_STATE_UPDATE',
            INTERIM_PREAMBLE: 'NCODE_INTERIM_PREAMBLE',
            SUBGOAL_TOGGLE: 'NCODE_SUBGOAL_TOGGLE',
            APPROVAL_REQUEST: 'NCODE_APPROVAL_REQUEST',
            APPROVAL_RESPONSE: 'NCODE_APPROVAL_RESPONSE',
        });
        for (const action of Object.values(NCODE_ACTIONS)) {
            expect(NCODE_ACTION_NAMES).toContain(action);
        }
    });

    it('canonicalises legacy broadcast names and leaves unknown actions alone', () => {
        for (const [legacyAction, canonicalAction] of Object.entries(NCODE_LEGACY_ACTION_ALIASES)) {
            expect(canonicalNcodeAction(legacyAction)).toBe(canonicalAction);
        }
        expect(canonicalNcodeAction('NCODE_APPROVAL_RESPONSE')).toBe(
            NCODE_ACTIONS.APPROVAL_RESPONSE
        );
        expect(canonicalNcodeAction('SEND_PROMPT')).toBe('SEND_PROMPT');
        expect(canonicalNcodeAction(null)).toBe('');
    });

    it('detects Ncode protocol actions', () => {
        expect(isNcodeAction('NCODE_GET_HARNESS_STATUS')).toBe(true);
        expect(isNcodeAction('NCODE_LEGACY_THING')).toBe(true);
        expect(isNcodeAction('SEND_PROMPT')).toBe(false);
        expect(isNcodeAction(undefined)).toBe(false);
    });

    it('lists legacy aliases for every broadcast that older panels consume', () => {
        expect(legacyAliasesFor(NCODE_ACTIONS.HARNESS_STATUS_UPDATE)).toContain(
            'NCODE_HARNESS_STATUS'
        );
        expect(legacyAliasesFor(NCODE_ACTIONS.GOAL_STATE_UPDATE)).toContain('NCODE_GOAL_STATE');
        expect(legacyAliasesFor(NCODE_ACTIONS.INTERIM_PREAMBLE)).toContain('NCODE_PREAMBLE');
        expect(legacyAliasesFor(NCODE_ACTIONS.COMPACT_STATE ?? 'unknown')).toEqual([]);
    });
});

describe('broadcastNcodeAction', () => {
    it('broadcasts the canonical action plus legacy aliases', async () => {
        const sendMessage = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('chrome', { runtime: { sendMessage } });

        const delivered = await broadcastNcodeAction(NCODE_ACTIONS.GOAL_STATE_UPDATE, {
            sessionId: 'session-1',
            goalSession: { workflowId: 'wf-1' },
        });

        expect(delivered).toBe(true);
        expect(sendMessage).toHaveBeenCalledTimes(2);
        expect(sendMessage.mock.calls[0][0]).toMatchObject({
            action: 'NCODE_GOAL_STATE_UPDATE',
            sessionId: 'session-1',
        });
        expect(sendMessage.mock.calls[1][0]).toMatchObject({
            action: 'NCODE_GOAL_STATE',
            sessionId: 'session-1',
        });
    });

    it('never throws when no extension page is listening', async () => {
        const sendMessage = vi.fn().mockRejectedValue(new Error('Receiving end does not exist'));
        vi.stubGlobal('chrome', { runtime: { sendMessage } });

        await expect(
            broadcastNcodeAction(NCODE_ACTIONS.INTERIM_PREAMBLE, { text: 'step 1' })
        ).resolves.toBe(false);
    });

    it('is a no-op outside a Chrome extension context', async () => {
        vi.stubGlobal('chrome', undefined);

        await expect(broadcastNcodeAction(NCODE_ACTIONS.HARNESS_STATUS_UPDATE, {})).resolves.toBe(
            false
        );
    });
});
