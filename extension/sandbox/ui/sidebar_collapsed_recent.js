import { t } from '../core/i18n.js';

const COLLAPSED_RECENT_PANEL_WIDTH = 320;
const COLLAPSED_RECENT_PANEL_MARGIN = 16;

export function getRecentSessions(controller) {
    return [...(controller.allSessions || [])]
        .filter((session) => session.id !== controller.currentSessionId)
        .sort(
            (first, second) =>
                Number(second.isPinned === true) - Number(first.isPinned === true) ||
                (second.timestamp || 0) - (first.timestamp || 0)
        )
        .slice(0, 8);
}

export function toggleCollapsedRecentPopover(controller) {
    if (controller.isCollapsedRecentOpen && controller.collapsedRecentPinned) {
        closeCollapsedRecentPopover(controller);
        return;
    }

    openCollapsedRecentPopover(controller, { pinned: true });
}

export function openCollapsedRecentPopover(controller, { pinned = false } = {}) {
    if (!controller.collapsedRecentPopover || !controller.collapsedRecentBtn) return;

    clearCollapsedRecentCloseTimer(controller);
    controller.closeItemMenu();
    controller.portalCollapsedRecentPopover();
    renderCollapsedRecentPopover(controller);
    if (pinned || !controller.isCollapsedRecentOpen) {
        controller.collapsedRecentPinned = pinned;
    }
    controller.isCollapsedRecentOpen = true;
    positionCollapsedRecentPopover(controller);
    controller.collapsedRecentPopover.hidden = false;
    controller.collapsedRecentBtn.setAttribute('aria-expanded', 'true');
}

export function positionCollapsedRecentPopover(controller) {
    if (
        !controller.isCollapsedRecentOpen ||
        !controller.collapsedRecentPopover ||
        !controller.collapsedRecentBtn
    ) {
        return;
    }

    const buttonRect = controller.collapsedRecentBtn.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const panelWidth = Math.min(
        COLLAPSED_RECENT_PANEL_WIDTH,
        Math.max(180, viewportWidth - COLLAPSED_RECENT_PANEL_MARGIN * 2)
    );
    const rightSideLeft = buttonRect.right;
    const fitsRight = rightSideLeft + panelWidth <= viewportWidth - COLLAPSED_RECENT_PANEL_MARGIN;
    const left = fitsRight
        ? rightSideLeft
        : Math.max(COLLAPSED_RECENT_PANEL_MARGIN, buttonRect.left - panelWidth);
    const maxTop = Math.max(
        COLLAPSED_RECENT_PANEL_MARGIN,
        viewportHeight - COLLAPSED_RECENT_PANEL_MARGIN * 2
    );
    const top = Math.min(Math.max(COLLAPSED_RECENT_PANEL_MARGIN, buttonRect.top), maxTop);

    Object.assign(controller.collapsedRecentPopover.style, {
        position: 'fixed',
        top: `${Math.round(top)}px`,
        left: `${Math.round(left)}px`,
        width: `${Math.round(panelWidth)}px`,
        maxHeight: `calc(100vh - ${Math.round(top + COLLAPSED_RECENT_PANEL_MARGIN)}px)`,
    });
}

export function closeCollapsedRecentPopover(controller) {
    clearCollapsedRecentCloseTimer(controller);

    if (!controller.collapsedRecentPopover || !controller.collapsedRecentBtn) {
        controller.isCollapsedRecentOpen = false;
        controller.collapsedRecentPinned = false;
        return;
    }

    controller.collapsedRecentPopover.hidden = true;
    controller.collapsedRecentBtn.setAttribute('aria-expanded', 'false');
    controller.isCollapsedRecentOpen = false;
    controller.collapsedRecentPinned = false;
}

export function clearCollapsedRecentCloseTimer(controller) {
    if (controller.collapsedRecentCloseTimer === null) return;

    window.clearTimeout(controller.collapsedRecentCloseTimer);
    controller.collapsedRecentCloseTimer = null;
}

export function scheduleCollapsedRecentClose(controller) {
    if (controller.collapsedRecentPinned) return;

    clearCollapsedRecentCloseTimer(controller);
    controller.collapsedRecentCloseTimer = window.setTimeout(() => {
        controller.collapsedRecentCloseTimer = null;
        closeCollapsedRecentPopover(controller);
    }, 120);
}

export function renderCollapsedRecentPopover(controller) {
    if (!controller.collapsedRecentPopover) return;

    const recentSessions = getRecentSessions(controller);
    const fragment = document.createDocumentFragment();

    const title = document.createElement('div');
    title.className = 'collapsed-recent-title';
    title.textContent = t('recentChats');
    fragment.appendChild(title);

    if (recentSessions.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'collapsed-recent-empty';
        emptyState.textContent = t('noConversations');
        fragment.appendChild(emptyState);
        controller.collapsedRecentPopover.replaceChildren(fragment);
        return;
    }

    recentSessions.forEach((session) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'collapsed-recent-item';
        item.textContent = session.title;
        item.onclick = () => {
            if (controller.itemCallbacks?.onSwitch) {
                controller.itemCallbacks.onSwitch(session.id);
            }
            closeCollapsedRecentPopover(controller);
        };
        fragment.appendChild(item);
    });

    controller.collapsedRecentPopover.replaceChildren(fragment);
}
