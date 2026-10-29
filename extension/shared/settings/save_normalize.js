import { DEFAULT_SIDE_PANEL_SCOPE } from '../config/constants.js';

export const MAX_BLACKLIST_LENGTH = 20000;

const THEME_SETTINGS = new Set(['system', 'dark', 'light']);
const SIDEBAR_BEHAVIOR_SETTINGS = new Set(['auto', 'restore', 'new']);
const SIDE_PANEL_SCOPE_SETTINGS = new Set(['remembered_tabs', 'global']);

/**
 * Strict toggle coercion: only real booleans (and their string forms) count.
 * A loose `payload !== false` would persist the string "false" as enabled.
 */
export function normalizeToggleEnabled(value) {
    if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
    return value === true;
}

export function normalizeThemeSetting(value, fallback = 'system') {
    return THEME_SETTINGS.has(value) ? value : fallback;
}

export function normalizeLanguageSetting(value, fallback = 'system') {
    const language = typeof value === 'string' ? value.trim() : '';
    return language || fallback;
}

export function normalizeSidebarBehaviorSetting(value) {
    return SIDEBAR_BEHAVIOR_SETTINGS.has(value) ? value : 'auto';
}

export function normalizeSidePanelScopeSetting(value) {
    return SIDE_PANEL_SCOPE_SETTINGS.has(value) ? value : DEFAULT_SIDE_PANEL_SCOPE;
}

export function normalizeBlacklistSetting(value) {
    const text = typeof value === 'string' ? value : '';
    return text.length > MAX_BLACKLIST_LENGTH ? text.slice(0, MAX_BLACKLIST_LENGTH) : text;
}

export function normalizeAccountIndicesSetting(value) {
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number' && Number.isInteger(value)) return String(value);
    return '0';
}
