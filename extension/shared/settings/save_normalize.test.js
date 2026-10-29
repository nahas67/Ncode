import { describe, expect, it } from 'vitest';
import {
    MAX_BLACKLIST_LENGTH,
    normalizeAccountIndicesSetting,
    normalizeBlacklistSetting,
    normalizeLanguageSetting,
    normalizeSidebarBehaviorSetting,
    normalizeSidePanelScopeSetting,
    normalizeThemeSetting,
    normalizeToggleEnabled,
} from './save_normalize.js';

describe('save_normalize', () => {
    it('coerces toggles strictly so "false" never persists as enabled', () => {
        expect(normalizeToggleEnabled(true)).toBe(true);
        expect(normalizeToggleEnabled('true')).toBe(true);
        expect(normalizeToggleEnabled(false)).toBe(false);
        expect(normalizeToggleEnabled('false')).toBe(false);
        expect(normalizeToggleEnabled(undefined)).toBe(false);
        expect(normalizeToggleEnabled(null)).toBe(false);
        expect(normalizeToggleEnabled(1)).toBe(false);
    });

    it('falls back for unknown themes and languages', () => {
        expect(normalizeThemeSetting('dark')).toBe('dark');
        expect(normalizeThemeSetting('neon')).toBe('system');
        expect(normalizeThemeSetting(null)).toBe('system');
        expect(normalizeLanguageSetting('zh-CN')).toBe('zh-CN');
        expect(normalizeLanguageSetting('')).toBe('system');
        expect(normalizeLanguageSetting(42)).toBe('system');
    });

    it('falls back for unknown sidebar behavior and scope', () => {
        expect(normalizeSidebarBehaviorSetting('restore')).toBe('restore');
        expect(normalizeSidebarBehaviorSetting('turbo')).toBe('auto');
        expect(normalizeSidePanelScopeSetting('global')).toBe('global');
        expect(normalizeSidePanelScopeSetting('everything')).toBe('remembered_tabs');
    });

    it('truncates oversized blacklists instead of blowing the quota', () => {
        expect(normalizeBlacklistSetting('a,b')).toBe('a,b');
        expect(normalizeBlacklistSetting(null)).toBe('');
        expect(normalizeBlacklistSetting(123)).toBe('');
        expect(normalizeBlacklistSetting('x'.repeat(MAX_BLACKLIST_LENGTH + 1))).toHaveLength(
            MAX_BLACKLIST_LENGTH
        );
    });

    it('keeps account indices as strings with a safe default', () => {
        expect(normalizeAccountIndicesSetting('0,2')).toBe('0,2');
        expect(normalizeAccountIndicesSetting(3)).toBe('3');
        expect(normalizeAccountIndicesSetting(null)).toBe('0');
        expect(normalizeAccountIndicesSetting('')).toBe('0');
    });
});
