/**
 * Escape HTML special characters to prevent XSS attacks.
 * @param {string} text - Raw text to escape
 * @returns {string} - Escaped text safe for innerHTML
 */
export function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
