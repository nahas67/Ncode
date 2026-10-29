// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { GeneralSettingsTemplate } from '../../templates/settings/general.js';
import { GeneralSection } from './general.js';

describe('GeneralSection', () => {
    beforeEach(() => {
        document.body.innerHTML = GeneralSettingsTemplate;
    });

    it('restores and saves the text selection blacklist', () => {
        const section = new GeneralSection();

        section.setTextSelectionBlacklist('github.com\n*.google.com');

        expect(document.getElementById('text-selection-blacklist').value).toBe(
            'github.com\n*.google.com'
        );
        expect(section.getData()).toMatchObject({
            textSelectionBlacklist: 'github.com\n*.google.com',
        });
    });

    it('restores and saves the side panel visibility scope', () => {
        const section = new GeneralSection();

        section.setSidePanelScope('global');

        expect(
            document.querySelector('input[name="sidepanel-scope"][value="global"]').checked
        ).toBe(true);
        expect(section.getData()).toMatchObject({
            sidePanelScope: 'global',
        });
    });

    it('edits custom text selection tools in the settings form', () => {
        const section = new GeneralSection();

        section.setCustomSelectionTools([
            {
                id: 'formal',
                name: 'Formal',
                prompt: 'Rewrite formally: {text}',
                enabled: true,
            },
        ]);

        expect(document.querySelectorAll('.custom-selection-tool-row')).toHaveLength(1);
        expect(document.querySelector('.custom-selection-tool-name').value).toBe('Formal');
        expect(document.querySelector('.custom-selection-tool-prompt').value).toBe(
            'Rewrite formally: {text}'
        );

        document.getElementById('add-custom-selection-tool').click();
        expect(document.querySelectorAll('.custom-selection-tool-row')).toHaveLength(2);

        document.querySelectorAll('.custom-selection-tool-name')[1].value = 'Explain code';
        document.querySelectorAll('.custom-selection-tool-prompt')[1].value =
            'Explain this code:\n{text}';

        expect(section.getData().customSelectionTools).toEqual([
            {
                id: 'formal',
                name: 'Formal',
                prompt: 'Rewrite formally: {text}',
                enabled: true,
            },
            {
                id: expect.stringMatching(/^custom_tool_[A-Z0-9-]+$/),
                name: 'Explain code',
                prompt: 'Explain this code:\n{text}',
                enabled: true,
            },
        ]);
    });
});
