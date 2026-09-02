/**
 * Pure helpers for status bar labels, session titles, and usage display.
 * Kept free of vscode so they can be unit-tested.
 */

export type StatusBarLabel = 'project' | 'session';
export type UsageFormat = 'percent' | 'tokens';

export const STATUS_BAR_NAME_MAX = 24;

function firstNonEmptyString(...vals: unknown[]): string {
    for (const v of vals) {
        if (typeof v === 'string' && v.trim()) {
            return v.trim();
        }
    }
    return '';
}

/**
 * Read title fields from a Claude Code JSONL entry.
 * custom-title (from /rename or -n) and ai-title (generated summary) are the
 * two types Claude Code writes; field names are tolerated loosely.
 */
export function readTitleFromEntry(entry: any): { customTitle?: string; aiTitle?: string } {
    if (!entry || typeof entry !== 'object') {
        return {};
    }
    if (entry.type === 'custom-title') {
        const customTitle = firstNonEmptyString(entry.customTitle, entry.title, entry.name);
        return customTitle ? { customTitle } : {};
    }
    if (entry.type === 'ai-title') {
        const aiTitle = firstNonEmptyString(entry.aiTitle, entry.title);
        return aiTitle ? { aiTitle } : {};
    }
    return {};
}

/** Prefer a user-chosen name over the generated title. */
export function pickSessionTitle(customTitle: string, aiTitle: string): string {
    return firstNonEmptyString(customTitle, aiTitle);
}

export function truncateLabel(text: string, max: number = STATUS_BAR_NAME_MAX): string {
    const t = text.trim();
    if (t.length <= max) {
        return t;
    }
    if (max <= 1) {
        return '…';
    }
    return t.slice(0, max - 1).trimEnd() + '…';
}

export function formatTokens(tokens: number): string {
    if (tokens >= 1_000_000) {
        return (tokens / 1_000_000).toFixed(1) + 'M';
    }
    if (tokens >= 1000) {
        return Math.round(tokens / 1000) + 'K';
    }
    return tokens.toString();
}

export function formatUsageValue(percentage: number, totalTokens: number, format: UsageFormat): string {
    if (format === 'tokens') {
        return formatTokens(totalTokens);
    }
    return `${percentage}%`;
}

export function formatStatusBarText(icon: string, displayName: string, usageValue: string): string {
    const iconSpace = icon ? ' ' : '';
    return `${icon}${iconSpace}${displayName}: ${usageValue}`;
}

/**
 * First duplicate stays unsuffixed; later copies get -2, -3, matching the
 * existing project-name numbering.
 */
export function disambiguateNames(names: string[]): string[] {
    const counts = new Map<string, number>();
    for (const name of names) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const nextIndex = new Map<string, number>();
    return names.map((name) => {
        if ((counts.get(name) ?? 0) <= 1) {
            return name;
        }
        const n = nextIndex.get(name) ?? 0;
        nextIndex.set(name, n + 1);
        return n === 0 ? name : `${name}-${n + 1}`;
    });
}

export function resolveDisplayName(opts: {
    label: StatusBarLabel;
    projectName: string;
    baseProjectName: string;
    sessionTitle: string;
    compactProjectName: string;
}): string {
    if (opts.label === 'session') {
        const title = opts.sessionTitle.trim();
        return truncateLabel(title || opts.baseProjectName);
    }
    return opts.compactProjectName || opts.projectName;
}
