import { describe, expect, it } from 'vitest';
import { getTargetSidePanelTabId } from './ui_context.js';

describe('getTargetSidePanelTabId', () => {
    it('prefers the authenticated sender tab over a conflicting claim', () => {
        expect(getTargetSidePanelTabId({ sidePanelTabId: 42 }, { tab: { id: 7 } })).toBe(7);
    });

    it('uses the claim when the sender has no tab (sidepanel host)', () => {
        expect(getTargetSidePanelTabId({ sidePanelTabId: 42 }, {})).toBe(42);
        expect(getTargetSidePanelTabId({ sidePanelTabId: 42 }, null)).toBe(42);
    });

    it('falls back to the sender tab when no claim is present', () => {
        expect(getTargetSidePanelTabId({}, { tab: { id: 7 } })).toBe(7);
    });

    it('returns null when neither claim nor sender tab is valid', () => {
        expect(getTargetSidePanelTabId({}, {})).toBeNull();
        expect(getTargetSidePanelTabId({ sidePanelTabId: -1 }, {})).toBeNull();
        expect(getTargetSidePanelTabId(null, null)).toBeNull();
    });
});
