import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('release workflow', () => {
    it('runs the full project check before packaging the extension', async () => {
        const source = await readFile('.github/workflows/package-extension.yml', 'utf8');
        const checkIndex = source.indexOf('run: npm run check');
        const packageIndex = source.indexOf('run: npm run package:extension');

        expect(checkIndex).toBeGreaterThan(-1);
        expect(packageIndex).toBeGreaterThan(-1);
        expect(checkIndex).toBeLessThan(packageIndex);
    });
});
