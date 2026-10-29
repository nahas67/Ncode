import { t } from '../core/i18n.js';
import { TemplateIcons } from './templates/icons.js';

export class TabSelectorController {
    constructor() {
        this.modal = null;
        this.listEl = null;
        this.btnClose = null;
        this.triggerBtn = null;
        this.controlBar = null;
        this.controlTarget = null;
        this.controlStop = null;
        this.controlTitle = null;
        this.controlMeta = null;
        this.controlStatus = null;
        this.controlFavicon = null;
        this.controlFallbackIcon = null;
        this.onSelect = null;
        this.onChoose = null;
        this.onStop = null;
        this.currentLockedId = null;
        this.controlVisible = false;
        this.controlState = { tab: null, attached: false };

        this.queryElements();
        this.bindEvents();
    }

    queryElements() {
        this.modal = document.getElementById('tab-selector-modal');
        this.listEl = document.getElementById('tab-list');
        this.btnClose = document.getElementById('close-tab-selector');
        this.triggerBtn = document.getElementById('tab-switcher-btn');
        this.controlBar = document.getElementById('browser-control-bar');
        this.controlTarget = document.getElementById('browser-control-target');
        this.controlStop = document.getElementById('browser-control-stop');
        this.controlTitle = document.getElementById('browser-control-title');
        this.controlMeta = document.getElementById('browser-control-meta');
        this.controlStatus = document.getElementById('browser-control-status');
        this.controlFavicon = document.getElementById('browser-control-favicon');
        this.controlFallbackIcon = document.getElementById('browser-control-fallback-icon');
    }

    bindEvents() {
        if (this.btnClose) {
            this.btnClose.addEventListener('click', () => this.close());
        }
        if (this.modal) {
            this.modal.addEventListener('click', (clickEvent) => {
                if (clickEvent.target === this.modal) this.close();
            });
        }
        if (this.controlTarget) {
            this.controlTarget.addEventListener('click', () => {
                if (this.onChoose) {
                    this.onChoose();
                    return;
                }
                this.triggerBtn?.click();
            });
        }
        if (this.controlStop) {
            this.controlStop.addEventListener('click', (clickEvent) => {
                clickEvent.stopPropagation();
                if (this.onStop) this.onStop();
            });
        }

        document.addEventListener('keydown', (keyEvent) => {
            if (
                keyEvent.key === 'Escape' &&
                this.modal &&
                this.modal.classList.contains('visible')
            ) {
                this.close();
            }
        });
    }

    setControlCallbacks({ onChoose, onStop } = {}) {
        this.onChoose = typeof onChoose === 'function' ? onChoose : null;
        this.onStop = typeof onStop === 'function' ? onStop : null;
    }

    setControlVisible(visible) {
        this.controlVisible = visible === true;
        document.body.classList.toggle('browser-control-active', this.controlVisible);
        if (this.controlBar) {
            this.controlBar.hidden = !this.controlVisible;
        }
        if (this.triggerBtn) {
            this.triggerBtn.hidden = true;
            if (this.controlVisible) this.resetTrigger();
        }
    }

    updateControlState({ tab = null, attached = false } = {}) {
        this.controlState = { tab, attached: attached === true };
        this.currentLockedId = tab?.id || null;
        this.renderControlState();
        this.updateTrigger(tab);
    }

    renderControlState() {
        const tab = this.controlState.tab;
        const attached = this.controlState.attached;
        const controllable = tab?.controllable !== false;

        if (this.controlTitle) {
            this.controlTitle.textContent = tab?.title || t('browserControlNoTab');
        }

        if (this.controlMeta) {
            this.controlMeta.textContent = tab ? this.formatTabMeta(tab) : '';
        }

        if (this.controlStatus) {
            if (!tab) {
                this.controlStatus.textContent = t('browserControlReady');
            } else if (!controllable) {
                this.controlStatus.textContent = t('browserControlUnavailable');
            } else {
                this.controlStatus.textContent = attached
                    ? t('browserControlDebugging')
                    : t('browserControlReady');
            }
        }

        if (this.controlBar) {
            this.controlBar.classList.toggle('is-attached', attached && controllable);
            this.controlBar.classList.toggle('is-unavailable', tab && !controllable);
            this.controlBar.classList.toggle('is-empty', !tab);
        }

        this.setFavicon(this.controlFavicon, tab?.favIconUrl, this.controlFallbackIcon);
    }

    open(tabs, onSelectCallback, lockedTabId) {
        this.onSelect = onSelectCallback;
        this.currentLockedId = lockedTabId;
        this.renderList(tabs);
        if (this.modal) this.modal.classList.add('visible');
    }

    close() {
        if (this.modal) this.modal.classList.remove('visible');
    }

    renderList(tabs) {
        if (!this.listEl) return;
        this.listEl.innerHTML = '';

        if (!tabs || tabs.length === 0) {
            const emptyState = document.createElement('div');
            emptyState.className = 'empty-list-state';
            emptyState.textContent = t('noTabsFound');
            this.listEl.appendChild(emptyState);
            return;
        }

        tabs.forEach((tab) => {
            const isLocked = tab.id === this.currentLockedId;
            const isControllable = tab.controllable !== false;

            const tabRow = document.createElement('div');
            tabRow.className = `history-item browser-tab-item ${isLocked ? 'active' : ''} ${!isControllable ? 'disabled' : ''}`;
            tabRow.dataset.tabId = String(tab.id);
            tabRow.setAttribute('role', 'button');
            tabRow.setAttribute('aria-disabled', String(!isControllable));
            if (isControllable) tabRow.tabIndex = 0;

            const icon = document.createElement('img');
            icon.src = tab.favIconUrl || '';
            icon.className = 'browser-tab-favicon';
            icon.onerror = () => {
                icon.hidden = true;
            };

            const titleSpan = document.createElement('span');
            titleSpan.className = 'history-title';
            titleSpan.textContent = tab.title || tab.url;

            const metaSpan = document.createElement('span');
            metaSpan.className = 'browser-tab-meta';
            metaSpan.textContent = isControllable
                ? this.formatTabMeta(tab)
                : t('browserControlUnavailableReason');

            const copyWrap = document.createElement('span');
            copyWrap.className = 'browser-tab-copy';
            copyWrap.appendChild(titleSpan);
            copyWrap.appendChild(metaSpan);

            const lockButton = document.createElement('button');
            lockButton.type = 'button';
            lockButton.className = 'tab-lock-only-btn';
            lockButton.classList.toggle('is-locked', isLocked);
            lockButton.disabled = !isControllable;

            if (isLocked) {
                lockButton.innerHTML = TemplateIcons.LOCK_CLOSED;
                lockButton.title = t('currentTab');
            } else {
                lockButton.innerHTML = TemplateIcons.LOCK_OPEN;
                lockButton.title = t('controlTabInBackground');
            }

            lockButton.onclick = (clickEvent) => {
                clickEvent.stopPropagation();
                if (!isControllable) return;

                this.updateTrigger(tab);

                if (this.onSelect) this.onSelect(tab.id, false);
                this.close();
            };

            tabRow.onclick = () => {
                if (!isControllable) return;

                if (!isLocked) {
                    this.updateTrigger(tab);
                }

                if (this.onSelect) this.onSelect(tab.id, true);
                this.close();
            };
            tabRow.onkeydown = (keyEvent) => {
                if (keyEvent.key !== 'Enter' && keyEvent.key !== ' ') return;
                keyEvent.preventDefault();
                tabRow.click();
            };

            tabRow.appendChild(icon);
            tabRow.appendChild(copyWrap);
            tabRow.appendChild(lockButton);

            this.listEl.appendChild(tabRow);
        });
    }

    updateTrigger(tab) {
        if (!this.triggerBtn) return;
        if (this.controlVisible) {
            this.triggerBtn.hidden = true;
            this.resetTrigger();
            return;
        }

        this.triggerBtn.innerHTML = '';

        if (tab && tab.favIconUrl) {
            const faviconElement = document.createElement('img');
            faviconElement.src = tab.favIconUrl;
            faviconElement.className = 'browser-trigger-favicon';

            faviconElement.onerror = () => {
                this.resetTrigger();
            };

            this.triggerBtn.appendChild(faviconElement);
            this.triggerBtn.title = `Locked: ${tab.title}`;
            this.triggerBtn.classList.add('tab-switcher-locked');
        } else {
            this.resetTrigger();
        }
    }

    resetTrigger() {
        if (!this.triggerBtn) return;
        this.triggerBtn.innerHTML = TemplateIcons.ACTIVE_TAB;
        this.triggerBtn.title = t('selectTabTooltip') || 'Select a tab to control';
        this.triggerBtn.classList.remove('tab-switcher-locked');
    }

    setFavicon(img, src, fallback) {
        if (!img) return;

        if (!src) {
            img.hidden = true;
            img.removeAttribute('src');
            if (fallback) fallback.hidden = false;
            return;
        }

        img.hidden = false;
        img.src = src;
        if (fallback) fallback.hidden = true;
        img.onerror = () => {
            img.hidden = true;
            img.removeAttribute('src');
            if (fallback) fallback.hidden = false;
        };
    }

    formatTabMeta(tab) {
        const url = tab?.url || '';
        try {
            const parsed = new URL(url);
            return parsed.hostname || url;
        } catch {
            return url;
        }
    }
}
