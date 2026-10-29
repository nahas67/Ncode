import { t } from '../core/i18n.js';
import { TemplateIcons } from '../ui/templates/icons.js';

export function createMessageEditControl({
    messageEl,
    contentEl,
    editorHost = messageEl,
    getCopyButton,
    getCurrentText,
    onEdit,
}) {
    const editBtn = document.createElement('button');
    editBtn.className = 'edit-btn';
    editBtn.title = t('editMessage');
    editBtn.setAttribute('aria-label', t('editMessage'));
    editBtn.innerHTML = TemplateIcons.EDIT;

    let cancelActiveEdit = null;

    editBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (cancelActiveEdit) return;

        messageEl.classList.add('editing');
        contentEl.hidden = true;
        const copyBtn = getCopyButton();
        if (copyBtn) copyBtn.hidden = true;
        editBtn.hidden = true;

        const editor = document.createElement('div');
        editor.className = 'message-edit';

        const textarea = document.createElement('textarea');
        textarea.className = 'message-edit-input';
        textarea.value = getCurrentText();
        textarea.rows = Math.max(2, Math.min(8, textarea.value.split('\n').length));

        const actions = document.createElement('div');
        actions.className = 'message-edit-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'message-edit-cancel';
        cancelBtn.textContent = t('cancelEdit');
        cancelBtn.title = t('cancelEdit');

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'message-edit-save';
        saveBtn.title = t('saveEdit');
        saveBtn.setAttribute('aria-label', t('saveEdit'));
        saveBtn.innerHTML = TemplateIcons.SEND;

        actions.appendChild(cancelBtn);
        actions.appendChild(saveBtn);
        editor.appendChild(textarea);
        editor.appendChild(actions);

        const fallbackReference = getCopyButton() || editBtn;
        if (fallbackReference?.parentNode === editorHost) {
            editorHost.insertBefore(editor, fallbackReference);
        } else {
            editorHost.appendChild(editor);
        }

        const cleanup = () => {
            document.removeEventListener('pointerdown', handleOutsidePointer, true);
            document.removeEventListener('keydown', handleDocumentKey, true);
            editor.remove();
            contentEl.hidden = false;
            const nextCopyBtn = getCopyButton();
            if (nextCopyBtn) nextCopyBtn.hidden = false;
            editBtn.hidden = false;
            messageEl.classList.remove('editing');
            cancelActiveEdit = null;
        };

        const cancel = () => {
            cleanup();
        };

        let isSaving = false;

        const save = async () => {
            if (isSaving) return;
            const nextText = textarea.value.trim();
            isSaving = true;
            saveBtn.disabled = true;

            try {
                const accepted = await onEdit(nextText);
                if (accepted !== false) {
                    cleanup();
                    return;
                }
            } catch (error) {
                console.error('Failed to edit message:', error);
            } finally {
                isSaving = false;
                saveBtn.disabled = false;
            }
        };

        function handleOutsidePointer(pointerEvent) {
            if (!messageEl.contains(pointerEvent.target)) {
                cancel();
            }
        }

        function handleDocumentKey(keyEvent) {
            if (keyEvent.key === 'Escape') {
                keyEvent.preventDefault();
                keyEvent.stopPropagation();
                cancel();
                return;
            }
            if ((keyEvent.metaKey || keyEvent.ctrlKey) && keyEvent.key === 'Enter') {
                keyEvent.preventDefault();
                keyEvent.stopPropagation();
                save();
            }
        }

        cancelBtn.addEventListener('click', (clickEvent) => {
            clickEvent.preventDefault();
            clickEvent.stopPropagation();
            cancel();
        });

        saveBtn.addEventListener('click', (clickEvent) => {
            clickEvent.preventDefault();
            clickEvent.stopPropagation();
            save();
        });

        textarea.addEventListener('input', () => {
            textarea.style.height = 'auto';
            textarea.style.height = `${textarea.scrollHeight}px`;
        });

        cancelActiveEdit = cancel;

        setTimeout(() => {
            document.addEventListener('pointerdown', handleOutsidePointer, true);
            document.addEventListener('keydown', handleDocumentKey, true);
            textarea.focus();
            textarea.setSelectionRange(textarea.value.length, textarea.value.length);
            textarea.dispatchEvent(new Event('input'));
        }, 0);
    });

    return {
        button: editBtn,
        cancel: () => {
            if (cancelActiveEdit) cancelActiveEdit();
        },
    };
}
