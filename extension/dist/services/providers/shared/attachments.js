/**
 * Shared provider utilities for attachment handling
 */

import {
    countUserAttachmentsByType,
    normalizeUserAttachments,
} from '../../../shared/attachments/index.js';

/**
 * Extract attachments from a message object
 */
export function getMessageAttachments(message) {
    if (message?.role !== 'user') return [];
    const attachments = normalizeUserAttachments(message?.attachments);
    if (attachments.length > 0) return attachments;
    return normalizeUserAttachments(message?.image);
}

/**
 * Assert that current provider supports the given file types
 * @throws {Error} If non-image files are provided
 */
export function assertCurrentAttachmentsSupported(files, providerName = 'this provider') {
    const counts = countUserAttachmentsByType(files);
    if (counts.files === 0) return;

    throw new Error(
        `${providerName} supports image attachments only. Remove non-image files or switch to Gemini Official/Web.`
    );
}

/**
 * Append a notice for unsupported file attachments
 */
export function textWithUnsupportedFileNotice(text, attachments) {
    const unsupported = normalizeUserAttachments(attachments).filter(
        (attachment) => !attachment.type.startsWith('image/')
    );
    if (unsupported.length === 0) return text || '';

    const names = unsupported
        .map((attachment) => attachment.name)
        .filter(Boolean)
        .join(', ');
    const suffix = names ? `: ${names}` : '';
    const marker = `[${unsupported.length} unsupported file attachment(s) omitted${suffix}]`;
    return [text, marker].filter(Boolean).join('\n');
}
