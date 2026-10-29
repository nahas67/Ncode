const GITHUB_REPOSITORY_BASE_URL = 'https://api.github.com/repos/yeahhe365/Gemini-Nexus';

async function readResponseField(response, field) {
    if (!response?.ok) return null;

    try {
        const metadata = await response.json();
        return metadata?.[field] ?? null;
    } catch {
        return null;
    }
}

export async function fetchGithubMetadata(fetchImpl = fetch) {
    const [starsResponse, releaseResponse] = await Promise.allSettled([
        fetchImpl(GITHUB_REPOSITORY_BASE_URL),
        fetchImpl(`${GITHUB_REPOSITORY_BASE_URL}/releases/latest`),
    ]);

    return {
        stars:
            starsResponse.status === 'fulfilled'
                ? await readResponseField(starsResponse.value, 'stargazers_count')
                : null,
        latestVersion:
            releaseResponse.status === 'fulfilled'
                ? await readResponseField(releaseResponse.value, 'tag_name')
                : null,
    };
}

export function compareVersionStrings(v1, v2) {
    const clean1 = String(v1 || '').replace(/^v/, '');
    const clean2 = String(v2 || '').replace(/^v/, '');
    const parts1 = clean1.split('.').map(Number);
    const parts2 = clean2.split('.').map(Number);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const num1 = parts1[i] || 0;
        const num2 = parts2[i] || 0;
        if (num1 > num2) return 1;
        if (num1 < num2) return -1;
    }

    return 0;
}
