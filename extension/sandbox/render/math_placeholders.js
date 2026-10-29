export class MathPlaceholderProtector {
    constructor() {
        this.blocks = [];
    }

    protect(text) {
        this.blocks = [];

        const protect = (regex, isDisplay) => {
            text = text.replace(regex, (match, content) => {
                const id = `@@MATH_BLOCK_${this.blocks.length}@@`;
                this.blocks.push({ id, content, isDisplay });
                return id;
            });
        };

        // Gemini escaped double-dollar block math.
        protect(/\\\$\$([\s\S]+?)\\\$\$/g, true);

        // Standard block math: $$ ... $$
        protect(/\$\$([\s\S]+?)\$\$/g, true);

        // Bracketed block math: \[ ... \]
        protect(/\\\[([\s\S]+?)\\\]/g, true);

        // Gemini escaped inline math: \$ ... \$
        protect(/\\\$([^$]+?)\\\$/g, false);

        // Parenthesized inline math: \( ... \)
        protect(/\\\(([\s\S]+?)\\\)/g, false);

        // Standard LaTeX inline math: $ ... $
        protect(/(?<!\\)\$([^$\n]+?)(?<!\\)\$/g, false);

        return text;
    }

    restore(html) {
        this.blocks.forEach(({ id, content, isDisplay }) => {
            // Escape HTML chars inside latex to prevent browser parsing issues
            const safeContent = content
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');

            // Use standard delimiters for KaTeX
            const delim = isDisplay ? '$$' : '$';

            html = html.replace(id, `${delim}${safeContent}${delim}`);
        });
        return html;
    }
}
