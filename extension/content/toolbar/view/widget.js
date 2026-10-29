(function () {
    const Layout = window.GeminiViewLayout;

    /**
     * Sub-controller for Floating Toolbar and Image Button
     */
    class WidgetView {
        constructor(elements) {
            this.elements = elements;
            this.initTooltips();
        }

        initTooltips() {
            const toolbar = this.elements.toolbar;
            if (!toolbar) return;
            const show = (targetButton) => {
                if (!targetButton || targetButton.dataset.tooltip) return;
                const title = targetButton.getAttribute('title');
                if (!title) return;
                targetButton.dataset.tooltip = title;
                targetButton.setAttribute('data-original-title', title);
                targetButton.removeAttribute('title');
            };
            const hide = (targetButton) => {
                if (!targetButton) return;
                const orig = targetButton.getAttribute('data-original-title');
                if (orig) {
                    targetButton.setAttribute('title', orig);
                    targetButton.removeAttribute('data-original-title');
                    targetButton.removeAttribute('data-tooltip');
                }
            };
            toolbar.addEventListener('mouseover', (event) => {
                const targetButton = event.target.closest('.btn');
                if (!targetButton || !toolbar.contains(targetButton)) return;
                show(targetButton);
            });
            toolbar.addEventListener('mouseout', (event) => {
                const targetButton = event.target.closest('.btn');
                if (!targetButton) return;
                // Only hide when leaving the button itself, not bubbling from child
                if (event.relatedTarget && targetButton.contains(event.relatedTarget)) return;
                hide(targetButton);
            });
            toolbar.addEventListener('focusin', (event) => {
                const targetButton = event.target.closest('.btn');
                if (!targetButton || !toolbar.contains(targetButton)) return;
                show(targetButton);
            });
            toolbar.addEventListener('focusout', (event) => {
                const targetButton = event.target.closest('.btn');
                if (!targetButton) return;
                hide(targetButton);
            });
        }

        showToolbar(rect, mousePoint) {
            if (!this.elements.toolbar) return;
            // Anchor to the selection (centered below, flipping above when tight)
            // rather than to the mouse cursor, so the toolbar never covers the
            // selected text and stays fully on-screen.
            Layout.positionElement(this.elements.toolbar, rect, false, mousePoint, {
                anchorMode: 'selection',
            });
            this.elements.toolbar.classList.add('visible');
        }

        hideToolbar() {
            if (this.elements.toolbar) this.elements.toolbar.classList.remove('visible');
        }

        showImageButton(rect) {
            if (!this.elements.imageBtn) return;
            const scrollX = window.scrollX || window.pageXOffset;
            const scrollY = window.scrollY || window.pageYOffset;

            // Position: Top-Left of image (with 10px padding)
            const left = rect.left + scrollX + 10;
            const top = rect.top + scrollY + 10;

            Object.assign(this.elements.imageBtn.style, { left: `${left}px`, top: `${top}px` });
            this.elements.imageBtn.classList.add('visible');
        }

        hideImageButton() {
            if (this.elements.imageBtn) this.elements.imageBtn.classList.remove('visible');
        }

        isToolbarVisible() {
            return this.elements.toolbar && this.elements.toolbar.classList.contains('visible');
        }

        toggleCopySelectionIcon(success) {
            const copySelectionButton = this.elements.buttons.copySelection;
            if (!copySelectionButton) return;

            const ICONS = window.GeminiToolbarIcons;
            if (success === true) {
                copySelectionButton.innerHTML = `${ICONS.CHECK}`;
            } else {
                copySelectionButton.innerHTML = `${ICONS.COPY}`;
            }
        }
    }

    window.GeminiViewWidget = WidgetView;
})();
