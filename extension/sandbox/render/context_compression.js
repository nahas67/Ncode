import { TemplateIcons } from '../ui/templates/icons.js';

export function appendContextCompressionNotice(container, text, options = {}) {
    const noticeElement = document.createElement('div');
    noticeElement.className = 'context-compression-notice';
    noticeElement.setAttribute('role', 'status');

    const lineStart = document.createElement('span');
    lineStart.className = 'context-compression-line';

    const label = document.createElement('span');
    label.className = 'context-compression-label';

    const icon = document.createElement('span');
    icon.className = 'context-compression-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = TemplateIcons.SUMMARY;

    const textSpan = document.createElement('span');
    textSpan.className = 'context-compression-text';
    textSpan.textContent = text;

    const lineEnd = document.createElement('span');
    lineEnd.className = 'context-compression-line';

    label.appendChild(icon);
    label.appendChild(textSpan);
    noticeElement.appendChild(lineStart);
    noticeElement.appendChild(label);
    noticeElement.appendChild(lineEnd);
    if (options.complete) {
        noticeElement.classList.add('context-compression-complete');
    }
    container.appendChild(noticeElement);

    if (options.scroll !== false) {
        setTimeout(() => {
            container.scrollTo({
                top: noticeElement.offsetTop - 20,
                behavior: 'smooth',
            });
        }, 10);
    }

    return {
        div: noticeElement,
        update: (nextText) => {
            textSpan.textContent = nextText;
            noticeElement.classList.add('context-compression-complete');
        },
        dispose: () => {
            noticeElement.remove();
        },
    };
}
