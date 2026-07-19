// ============================================================================
// TYPES
// ============================================================================

import type { SessionInfo } from './sessionDetection';

/**
 * Configuration for StatusBarItem rendering.
 *
 * Six fields sourced from the VS Code configuration that control how
 * each session is displayed in the status bar.
 */
export interface StatusBarConfig {
    /** Percentage at which to show warning color (yellow). */
    warningThreshold: number;
    /** Percentage at which to show danger color (red). */
    dangerThreshold: number;
    /** When true, automatically assign different pastel colors per project. */
    autoColor: boolean;
    /** Base color used when autoColor is off. */
    baseColor: string;
    /** Whether to show emoji icons based on project name. */
    showEmoji: boolean;
    /** Whether to shorten project names for compact display. */
    compactMode: boolean;
}

/**
 * Read-only snapshot of a StatusBarItem for test verification.
 */
export interface StatusBarItemSnapshot {
    /** Full path to the session's .jsonl file (used as the unique key). */
    sessionFile: string;
    /** The rendered text displayed on the status bar item. */
    text: string;
    /** The tooltip content as a plain string. */
    tooltip: string;
    /** Text color (CSS hex or undefined). */
    color: string | undefined;
    /** Background color ThemeColor id, if any (e.g. "statusBarItem.errorBackground"). */
    backgroundColor: string | undefined;
}

// ============================================================================
// VS CODE SURFACE (dependency injection for testability)
// ============================================================================

/**
 * Minimal surface of VS Code APIs that StatusBarManager depends on.
 *
 * In the extension, the real vscode module is used. In tests, a mock
 * implementation is injected so tests can run without the vscode runtime.
 */
export interface VSCodeSurface {
    createStatusBarItem(alignment: number, priority: number): VSCodeStatusBarItem;
    ThemeColor: new (id: string) => { id: string };
    MarkdownString: new (value: string, supportHtml?: boolean) => { value: string };
    StatusBarAlignment: { Right: number };
}

/**
 * Minimal interface matching vscode.StatusBarItem.
 */
export interface VSCodeStatusBarItem {
    show(): void;
    dispose(): void;
    text: string;
    tooltip: { value: string };
    color: string | undefined;
    backgroundColor: { id: string } | undefined;
    command: { command: string; title: string; arguments: string[] } | undefined;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Pastel color palette for auto-coloring projects. */
const PASTEL_PALETTE = [
    '#a8d8ea', // Soft blue
    '#d4a5a5', // Dusty rose
    '#b5d8c7', // Sage green
    '#e8d5b7', // Warm beige
    '#c9b1ff', // Lavender
    '#ffd6a5', // Peach
    '#caffbf', // Mint
    '#bdb2ff', // Periwinkle
    '#ffc6ff', // Pink
];

/** Base color variations (subtle shifts from the user's chosen color). */
const BASE_COLOR_VARIATIONS: Record<string, string[]> = {
    'White': ['#ffffff', '#f5f5f5', '#ebebeb', '#e0e0e0', '#d5d5d5'],
    'Blue': ['#a8d8ea', '#9ecfe0', '#94c6d6', '#8abccc', '#80b2c2'],
    'Purple': ['#c9b1ff', '#bfa7f5', '#b59deb', '#ab93e1', '#a189d7'],
    'Cyan': ['#a0e7e5', '#96ddd9', '#8cd3cd', '#82c9c1', '#78bfb5'],
    'Green': ['#b5d8c7', '#abcebd', '#a1c4b3', '#97baa9', '#8db09f'],
    'Yellow': ['#ffeaa7', '#f5e09d', '#ebd693', '#e1cc89', '#d7c27f'],
    'Orange': ['#ffd6a5', '#f5cc9b', '#ebc291', '#e1b887', '#d7ae7d'],
    'Pink': ['#ffc6ff', '#f5bcf5', '#ebb2eb', '#e1a8e1', '#d79ed7'],
};

// ============================================================================
// REAL VS CODE SURFACE
// ============================================================================

function getRealVSCodeSurface(): VSCodeSurface {
    // Dynamic require — only called in the extension context, never in tests.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode');
    return {
        createStatusBarItem: (alignment: number, priority: number) =>
            vscode.window.createStatusBarItem(alignment, priority),
        ThemeColor: vscode.ThemeColor,
        MarkdownString: vscode.MarkdownString,
        StatusBarAlignment: { Right: vscode.StatusBarAlignment.Right },
    };
}

// ============================================================================
// INTERNAL (exported via _test for testing)
// ============================================================================

/** Emoji mappings: [keywords[], emoji][] */
const EMOJI_MAP: [string[], string][] = [
    [['music', 'audio', 'sound', 'song', 'beat', 'dj', 'ableton', 'daw', 'synth', 'midi', 'tone', 'rhythm'], '🎵'],
    [['game', 'play', 'unity', 'unreal', 'godot', 'arcade', 'puzzle'], '🎮'],
    [['web', 'website', 'frontend', 'react', 'vue', 'angular', 'html', 'css', 'ui', 'ux'], '🌐'],
    [['api', 'backend', 'server', 'rest', 'graphql', 'microservice'], '⚙️'],
    [['mobile', 'ios', 'android', 'app', 'flutter', 'react-native', 'swift', 'kotlin'], '📱'],
    [['data', 'ml', 'ai', 'machine', 'learning', 'model', 'train', 'neural', 'tensor'], '🤖'],
    [['database', 'db', 'sql', 'mongo', 'postgres', 'mysql', 'redis'], '🗄️'],
    [['devops', 'cloud', 'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'k8s', 'deploy'], '☁️'],
    [['security', 'auth', 'crypto', 'encrypt', 'password', 'oauth'], '🔐'],
    [['test', 'spec', 'jest', 'mocha', 'cypress', 'selenium'], '🧪'],
    [['doc', 'docs', 'readme', 'wiki', 'guide', 'tutorial'], '📚'],
    [['tool', 'extension', 'plugin', 'vscode', 'editor'], '🔧'],
    [['chat', 'message', 'slack', 'discord', 'bot'], '💬'],
    [['finance', 'money', 'payment', 'bank', 'crypto', 'trade'], '💰'],
    [['health', 'medical', 'fitness', 'workout'], '❤️'],
    [['shop', 'store', 'ecommerce', 'cart', 'product'], '🛒'],
    [['video', 'stream', 'youtube', 'media', 'film', 'movie'], '🎬'],
    [['art', 'design', 'draw', 'paint', 'sketch', 'creative', 'graphic'], '🎨'],
];

/** Exported via _test for testing. */
function getEmojiForProject(projectName: string): string {
    const name = projectName.toLowerCase();

    for (const [keywords, emoji] of EMOJI_MAP) {
        for (const keyword of keywords) {
            if (name.includes(keyword)) {
                return emoji;
            }
        }
    }

    return '🧠';
}

/** Exported via _test for testing. Extracts the last syllable for project name abbreviation. */
function extractLastSyllable(word: string): string {
    const match = word.match(/[bcdfghjklmnpqrstvwxz]+[aeiou]+[bcdfghjklmnpqrstvwxz]*$/i);
    if (match) {
        return match[0];
    }
    return word.slice(-Math.min(4, word.length));
}

/** Exported via _test for testing. */
function getShortName(projectName: string, customNames: Record<string, string>): string {
    // Check custom override first (check both full name and base name)
    if (customNames[projectName]) {
        return customNames[projectName];
    }

    // Extract session number suffix if present (e.g., "my-project-2" → "-2")
    const sessionMatch = projectName.match(/-(\d+)$/);
    const sessionSuffix = sessionMatch ? sessionMatch[0] : '';
    const baseName = sessionMatch ? projectName.slice(0, -sessionSuffix.length) : projectName;

    // Check custom override for base name too
    if (customNames[baseName]) {
        return customNames[baseName] + sessionSuffix;
    }

    // If base name is already short (5 chars or less), don't shorten
    if (baseName.length <= 5) {
        return projectName;
    }

    // Split on common delimiters (dash, underscore, space) or camelCase boundaries
    const words = baseName.split(/[-_\s]|(?=[A-Z])/).filter(w => w.length > 0);

    let shortBase: string;
    if (words.length > 1) {
        // Multi-word: create acronym from first letter of each word
        shortBase = words.map(w => w[0]?.toUpperCase() || '').join('');
    } else {
        // Single-word: first letter uppercase + last syllable
        const lastSyllable = extractLastSyllable(baseName);
        shortBase = baseName[0].toUpperCase() + lastSyllable;
    }

    return shortBase + sessionSuffix;
}

/** Exported via _test for testing. Formats token count with K/M suffix for display. */
function formatTokens(tokens: number): string {
    if (tokens >= 1_000_000) {
        return (tokens / 1_000_000).toFixed(1) + 'M';
    } else if (tokens >= 1000) {
        return Math.round(tokens / 1000) + 'K';
    }
    return tokens.toString();
}

/** Exported via _test for testing. */
function buildSessionText(
    session: SessionInfo,
    config: StatusBarConfig,
    shortNames: Record<string, string>,
): string {
    const icon = config.showEmoji ? getEmojiForProject(session.projectName) : '';
    const iconSpace = config.showEmoji ? ' ' : '';
    const displayName = config.compactMode
        ? getShortName(session.projectName, shortNames)
        : session.projectName;
    return `${icon}${iconSpace}${displayName}: ${session.percentage}%`;
}

/** Exported via _test for testing. Picks a VS Code workbench color ID based on usage percentage. */
function getBackgroundColorId(
    percentage: number,
    warningThreshold: number,
    dangerThreshold: number,
): string | undefined {
    if (percentage >= dangerThreshold) {
        return 'statusBarItem.errorBackground';
    } else if (percentage >= warningThreshold) {
        return 'statusBarItem.warningBackground';
    }
    return undefined;
}

/** Exported via _test for testing. */
function buildTooltip(session: SessionInfo): string {
    const firstMsgLine = session.firstMessage ? `💬 *"${session.firstMessage}"*\n\n` : '';

    return (
        `**${session.projectName}** (${session.sessionId})\n\n` +
        firstMsgLine +
        `📁 \`${session.projectPath}\`\n\n` +
        `🤖 Model: \`${session.model || 'Unknown'}\`\n\n` +
        `📊 **Context Usage: ${session.percentage}%**\n\n` +
        `| Type | Tokens |\n|------|--------|\n` +
        `| Cache Read | ${formatTokens(session.cacheReadTokens)} |\n` +
        `| Cache Creation | ${formatTokens(session.cacheCreationTokens)} |\n` +
        `| **Total** | **${formatTokens(session.totalTokens)}** / ${formatTokens(session.contextLimit)} |\n\n` +
        `🕐 Last updated: ${session.lastUpdated.toLocaleTimeString()}\n\n` +
        `*Click to hide*`
    );
}

/** Exported via _test for testing. */
function assignProjectColors(
    sessions: SessionInfo[],
    config: StatusBarConfig,
): Map<string, string> {
    const projectColorMap = new Map<string, string>();
    let colorIndex = 0;

    if (config.autoColor) {
        for (const session of sessions) {
            if (!projectColorMap.has(session.projectName)) {
                projectColorMap.set(
                    session.projectName,
                    PASTEL_PALETTE[colorIndex % PASTEL_PALETTE.length],
                );
                colorIndex++;
            }
        }
    } else {
        const variations = BASE_COLOR_VARIATIONS[config.baseColor] || BASE_COLOR_VARIATIONS['White'];
        for (const session of sessions) {
            if (!projectColorMap.has(session.projectName)) {
                projectColorMap.set(
                    session.projectName,
                    variations[colorIndex % variations.length],
                );
                colorIndex++;
            }
        }
    }

    return projectColorMap;
}

/** Exported via _test for testing. */
function filterHiddenSessions(
    sessions: SessionInfo[],
    hiddenSessions: Map<string, number>,
): SessionInfo[] {
    const visible: SessionInfo[] = [];
    for (const session of sessions) {
        const hiddenAt = hiddenSessions.get(session.sessionFile);
        if (!hiddenAt) {
            visible.push(session);
            continue;
        }
        if (session.lastUpdated.getTime() > hiddenAt) {
            // New activity — auto-unhide
            hiddenSessions.delete(session.sessionFile);
            visible.push(session);
        }
        // else: still hidden, skip
    }
    return visible;
}

// ============================================================================
// STATUS BAR MANAGER
// ============================================================================

/**
 * Manages the lifecycle of VS Code StatusBarItems for Claude Code sessions.
 *
 * Responsibilities:
 * - Hide filtering with automatic unhide detection
 * - Top-5 truncation (most recent sessions only)
 * - Emoji matching, compact naming, token formatting
 * - Color assignment (auto-palette or base-color variations)
 * - Tooltip Markdown formatting
 * - StatusBarItem creation, update, and disposal
 * - Hidden session tracking
 */
export class StatusBarManager {
    private items = new Map<string, VSCodeStatusBarItem>();
    private hiddenSessions = new Map<string, number>();
    private lastSessions: SessionInfo[] = [];
    private lastConfig: StatusBarConfig | null = null;
    private lastShortNames: Record<string, string> = {};
    private vs: VSCodeSurface;

    /**
     * @param vsSurface  VS Code API surface. In production this is the real
     *                   vscode module; in tests a mock is injected.
     */
    constructor(vsSurface?: VSCodeSurface) {
        this.vs = vsSurface || getRealVSCodeSurface();
    }

    // -- Public API ---------------------------------------------------------

    /**
     * Update all status bar items to reflect the given sessions and config.
     *
     * Pipeline: hide filtering → auto-unhide detection → top-5 truncation →
     *           color assignment → create/update/destroy StatusBarItems.
     *
     * @param sessions    Active sessions (already sorted by lastUpdated desc).
     * @param config      Rendering configuration.
     * @param shortNames  Custom short-name overrides for compact mode.
     */
    updateSessions(
        sessions: SessionInfo[],
        config: StatusBarConfig,
        shortNames?: Record<string, string>,
    ): void {
        this.lastSessions = sessions;
        this.lastConfig = config;
        this.lastShortNames = shortNames || {};

        // Step 1: Hide filtering with auto-unhide detection
        const visibleSessions = filterHiddenSessions(sessions, this.hiddenSessions);

        // Step 2: Top-5 truncation (most recent first)
        const top5 = visibleSessions.slice(0, 5);

        // Step 3: Color assignment
        const projectColorMap = assignProjectColors(top5, config);

        // Step 4: Create/update/destroy StatusBarItems
        this.renderItems(top5, config, projectColorMap);
    }

    /**
     * Hide a session from the status bar. Records the hide timestamp and
     * immediately refreshes with the last-known sessions/config.
     *
     * The session will auto-unhide if its file is modified after the hide time.
     */
    hideSession(sessionFile: string): void {
        this.hiddenSessions.set(sessionFile, Date.now());
        if (this.lastSessions.length > 0 && this.lastConfig) {
            this.updateSessions(this.lastSessions, this.lastConfig, this.lastShortNames);
        }
    }

    /**
     * Dispose all StatusBarItems and reset internal state.
     */
    dispose(): void {
        this.items.forEach(item => item.dispose());
        this.items.clear();
        this.hiddenSessions.clear();
        this.lastSessions = [];
        this.lastConfig = null;
        this.lastShortNames = {};
    }

    /**
     * Return read-only snapshots of the current items, for test verification.
     */
    getItems(): StatusBarItemSnapshot[] {
        const result: StatusBarItemSnapshot[] = [];
        // Iterate over lastSessions order to maintain consistent ordering
        const seen = new Set<string>();
        for (const session of this.lastSessions) {
            const item = this.items.get(session.sessionFile);
            if (item && !seen.has(session.sessionFile)) {
                seen.add(session.sessionFile);
                result.push({
                    sessionFile: session.sessionFile,
                    text: item.text,
                    tooltip: item.tooltip?.value || '',
                    color: item.color,
                    backgroundColor: item.backgroundColor?.id,
                });
            }
        }
        // Include any items for sessions not in lastSessions (shouldn't happen normally)
        for (const [sessionFile, item] of this.items) {
            if (!seen.has(sessionFile)) {
                result.push({
                    sessionFile,
                    text: item.text,
                    tooltip: item.tooltip?.value || '',
                    color: item.color,
                    backgroundColor: item.backgroundColor?.id,
                });
            }
        }
        return result;
    }

    // -- Internal -----------------------------------------------------------

    /**
     * Create, update, or dispose StatusBarItems to match the given sessions.
     */
    private renderItems(
        sessions: SessionInfo[],
        config: StatusBarConfig,
        projectColorMap: Map<string, string>,
    ): void {
        const seenPaths = new Set<string>();

        for (let i = 0; i < sessions.length; i++) {
            const session = sessions[i];
            seenPaths.add(session.sessionFile);

            let item = this.items.get(session.sessionFile);

            if (!item) {
                // Create new status bar item — Right aligned, very high priority
                // to appear left of Claude's own status bar items.
                const priority = 900 + (sessions.length - i);
                item = this.vs.createStatusBarItem(
                    this.vs.StatusBarAlignment.Right,
                    priority,
                );
                this.items.set(session.sessionFile, item);
            }

            // Update text
            item.text = buildSessionText(session, config, this.lastShortNames);

            // Update background color based on thresholds
            const bgId = getBackgroundColorId(
                session.percentage,
                config.warningThreshold,
                config.dangerThreshold,
            );
            if (bgId) {
                item.backgroundColor = new this.vs.ThemeColor(bgId);
            } else {
                item.backgroundColor = undefined;
            }

            // Update text color from project color map
            item.color = projectColorMap.get(session.projectName) || '#ffffff';

            // Update tooltip
            const tooltipContent = buildTooltip(session);
            item.tooltip = new this.vs.MarkdownString(tooltipContent);

            // Click to hide this session
            item.command = {
                command: 'claudeContextBar.hideSession',
                title: 'Hide Session',
                arguments: [session.sessionFile],
            };

            item.show();
        }

        // Remove status bar items for sessions that are no longer visible
        for (const [sessionFile, item] of this.items) {
            if (!seenPaths.has(sessionFile)) {
                item.dispose();
                this.items.delete(sessionFile);
            }
        }
    }
}

export const _test = {
    getEmojiForProject,
    extractLastSyllable,
    getShortName,
    formatTokens,
    buildSessionText,
    getBackgroundColorId,
    buildTooltip,
    assignProjectColors,
    filterHiddenSessions,
};
