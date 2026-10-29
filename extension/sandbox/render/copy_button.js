import { copyToClipboard } from './clipboard.js';
import { t } from '../core/i18n.js';
import { TemplateIcons } from '../ui/templates/icons.js';
import '../../shared/ui/copy_feedback.js';

export function createCopyButton(getCopyText) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy-btn';
    button.title = t('copyContent');
    button.setAttribute('aria-label', t('copyContent'));
    button.innerHTML = TemplateIcons.COPY;

    button.addEventListener('click', async () => {
        try {
            await copyToClipboard(getCopyText());
            globalThis.GeminiCopyFeedback.showCopied(button, t('copied'));
        } catch (error) {
            console.error('Failed to copy text: ', error);
        }
    });

    return button;
}
