import { t } from '../core/i18n.js';

function getSidebarLanguage() {
    return document.documentElement.lang?.startsWith('zh') ? 'zh' : 'en';
}

function getValidSessionDate(session) {
    const timestamp = Number(session?.timestamp);
    const date = new Date(Number.isFinite(timestamp) ? timestamp : 0);
    return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

export function categorizeSessionsByDate(sessions, now = new Date()) {
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(todayStart.getDate() - 1);
    const sevenDaysAgoStart = new Date(todayStart);
    sevenDaysAgoStart.setDate(todayStart.getDate() - 8);
    const thirtyDaysAgoStart = new Date(todayStart);
    thirtyDaysAgoStart.setDate(todayStart.getDate() - 30);

    const categoryLabels = {
        today: t('historyToday'),
        yesterday: t('historyYesterday'),
        sevenDays: t('historyPrevious7Days'),
        thirtyDays: t('historyPrevious30Days'),
    };
    const staticOrder = [
        categoryLabels.today,
        categoryLabels.yesterday,
        categoryLabels.sevenDays,
        categoryLabels.thirtyDays,
    ];
    const categories = new Map();
    const language = getSidebarLanguage();
    const monthFormatter = new Intl.DateTimeFormat(
        language === 'zh' ? 'zh-CN-u-nu-hanidec' : 'en-US',
        {
            year: 'numeric',
            month: 'long',
        }
    );

    sessions.forEach((session) => {
        const sessionDate = getValidSessionDate(session);
        let categoryName = '';

        if (sessionDate >= todayStart) {
            categoryName = categoryLabels.today;
        } else if (sessionDate >= yesterdayStart) {
            categoryName = categoryLabels.yesterday;
        } else if (sessionDate >= sevenDaysAgoStart) {
            categoryName = categoryLabels.sevenDays;
        } else if (sessionDate >= thirtyDaysAgoStart) {
            categoryName = categoryLabels.thirtyDays;
        } else {
            categoryName = monthFormatter.format(sessionDate);
        }

        if (!categories.has(categoryName)) {
            categories.set(categoryName, []);
        }
        categories.get(categoryName).push(session);
    });

    const monthCategories = [...categories.keys()]
        .filter((categoryName) => !staticOrder.includes(categoryName))
        .sort(
            (leftCategory, rightCategory) =>
                getValidSessionDate(categories.get(rightCategory)?.[0]).getTime() -
                getValidSessionDate(categories.get(leftCategory)?.[0]).getTime()
        );

    const categoryOrder = [...staticOrder, ...monthCategories].filter(
        (categoryName) => (categories.get(categoryName) || []).length > 0
    );

    return { categories, categoryOrder };
}

export function partitionSessionsByGroup(sessions, groups) {
    const groupedSessions = new Map();
    const ungroupedSessions = [];

    groups.forEach((group) => groupedSessions.set(group.id, []));

    sessions.forEach((session) => {
        if (session.groupId && groupedSessions.has(session.groupId)) {
            groupedSessions.get(session.groupId).push(session);
            return;
        }
        ungroupedSessions.push(session);
    });

    return { groupedSessions, ungroupedSessions };
}
