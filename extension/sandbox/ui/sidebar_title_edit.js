import { t } from '../core/i18n.js';

export function createGroupTitleEditor(controller, group) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'history-group-edit-input';
    input.value = controller.editingGroupTitle || group.title;
    input.setAttribute('aria-label', t('renameGroup'));
    input.onclick = (clickEvent) => clickEvent.stopPropagation();
    input.oninput = (inputEvent) => {
        controller.editingGroupTitle = inputEvent.target.value;
    };
    input.onblur = () => controller.confirmGroupTitleEdit();
    input.onkeydown = (keyboardEvent) => {
        keyboardEvent.stopPropagation();
        if (keyboardEvent.key === 'Enter' && !keyboardEvent.isComposing) {
            keyboardEvent.preventDefault();
            controller.confirmGroupTitleEdit();
        } else if (keyboardEvent.key === 'Escape') {
            keyboardEvent.preventDefault();
            controller.cancelGroupTitleEdit();
        }
    };
    return input;
}

export function focusEditingTitleInput(controller) {
    if (!controller.editingGroupId && !controller.editingSessionId) return;

    const input = controller.listEl.querySelector(
        '.history-group-edit-input, .history-session-edit-input'
    );
    if (!input) return;

    input.focus({ preventScroll: true });
    input.select();
}

export function createSessionTitleEditor(controller, session) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'history-session-edit-input';
    input.value = controller.editingSessionTitle || session.title;
    input.setAttribute('aria-label', t('renameChat'));
    input.onclick = (clickEvent) => clickEvent.stopPropagation();
    input.oninput = (inputEvent) => {
        controller.editingSessionTitle = inputEvent.target.value;
    };
    input.onblur = () => controller.confirmSessionTitleEdit();
    input.onkeydown = (keyboardEvent) => {
        keyboardEvent.stopPropagation();
        if (keyboardEvent.key === 'Enter' && !keyboardEvent.isComposing) {
            keyboardEvent.preventDefault();
            controller.confirmSessionTitleEdit();
        } else if (keyboardEvent.key === 'Escape') {
            keyboardEvent.preventDefault();
            controller.cancelSessionTitleEdit();
        }
    };
    return input;
}

export function startSessionTitleEdit(controller, session) {
    controller.editingSessionId = session.id;
    controller.editingSessionTitle = session.title;
    controller.activeMenuId = null;
    controller.activeMenuType = null;
    controller._renderDOM(controller._getDisplayedSessions());
}

export function confirmSessionTitleEdit(controller) {
    if (!controller.editingSessionId) return;

    const sessionId = controller.editingSessionId;
    const title = controller.editingSessionTitle.trim();
    controller.editingSessionId = null;
    controller.editingSessionTitle = '';

    if (title && controller.itemCallbacks?.onRename) {
        controller.itemCallbacks.onRename(sessionId, title);
        return;
    }

    controller._renderDOM(controller._getDisplayedSessions());
}

export function cancelSessionTitleEdit(controller) {
    if (!controller.editingSessionId) return;

    controller.editingSessionId = null;
    controller.editingSessionTitle = '';
    controller._renderDOM(controller._getDisplayedSessions());
}

export function startGroupTitleEdit(controller, group) {
    controller.editingGroupId = group.id;
    controller.editingGroupTitle = group.title;
    controller.activeMenuId = null;
    controller.activeMenuType = null;
    controller._renderDOM(controller._getDisplayedSessions());
}

export function confirmGroupTitleEdit(controller) {
    if (!controller.editingGroupId) return;

    const groupId = controller.editingGroupId;
    const title = controller.editingGroupTitle.trim();
    controller.editingGroupId = null;
    controller.editingGroupTitle = '';

    if (title && controller.itemCallbacks?.onRenameGroup) {
        controller.itemCallbacks.onRenameGroup(groupId, title);
        return;
    }

    controller._renderDOM(controller._getDisplayedSessions());
}

export function cancelGroupTitleEdit(controller) {
    if (!controller.editingGroupId) return;

    controller.editingGroupId = null;
    controller.editingGroupTitle = '';
    controller._renderDOM(controller._getDisplayedSessions());
}
