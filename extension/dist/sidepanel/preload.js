(function () {
    try {
        const cachedTheme = localStorage.getItem('geminiTheme') || 'system';
        const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (cachedTheme === 'dark' || (cachedTheme === 'system' && systemDark)) {
            document.documentElement.setAttribute('data-theme', 'dark');
        }
    } catch {
        // 静默降级:localStorage 不可用时跳过主题预加载,由后续逻辑兜底
    }
})();
