/**
 * The statusBar module: this refresh's facts in, the Bar items the status bar
 * should show out.
 *
 * `describeStatusBar` is this module's whole interface. Everything that
 * decides what an item looks like sits behind it — the emoji keyword table,
 * the short-name and syllable rules, the two palettes and how a colour is
 * picked, display-name resolution with its numbering and truncation, the token
 * abbreviation, the background level, the tooltip markdown and the priority
 * arithmetic — so "why does the bar read like that" has one place to look.
 *
 * The result is plain data, not vscode objects: `background` is a
 * `ContextTokenLevel`, `tooltip` is the raw markdown, `command` is a plain
 * object. This module imports `vscode` neither at runtime nor as a type, so a
 * test drives the entire display from a handful of `SessionInfo` values and a
 * Settings snapshot; until #67 all of this lived in the extension entry point
 * and none of it was covered.
 *
 * What stays with the caller is the vscode side: creating, reusing, pruning
 * and disposing the items, and the three conversions from this plain data to
 * vscode's types. Which sessions reach here at all — the ordering, the
 * sessions the user has clicked away, the cap of five — is display selection
 * and also the caller's, as is the scan behind it.
 */

import { ContextTokenLevel, getContextTokenLevel } from './contextThreshold';
import { SessionInfo } from './sessions';
import { Settings, StatusBarLabel } from './settings';

/** What a click on a Bar item runs, in the shape vscode's `command` takes. */
export interface BarItemCommand {
    command: string;
    title: string;
    arguments: unknown[];
}

/**
 * The complete description of one status bar item.
 *
 * Alignment is not a field: every item this extension shows is right-aligned,
 * and a constant that never varies belongs with the caller that applies it.
 * `key` is what the item is reused under across refreshes — a session item
 * uses its session file path.
 */
export interface BarItem {
    key: string;
    text: string;
    color?: string;
    background: ContextTokenLevel;
    tooltip: string;
    command?: BarItemCommand;
    priority: number;
}

/**
 * Everything one refresh needs to decide what the bar looks like.
 *
 * An object rather than positional parameters because the list grows: #68
 * folds the subscription usage item and the missing-directory warning in here,
 * and those add the usage data, the projects directory, whether it is missing
 * and whether the config directory was set explicitly. New facts are new
 * fields; no call site changes shape.
 */
export interface StatusBarFacts {
    /** The Active sessions to show, already ordered, filtered and capped. */
    sessions: SessionInfo[];
    /** The snapshot for this refresh. */
    settings: Settings;
    /**
     * This refresh's time, in epoch milliseconds. Unused by the session items;
     * the subscription usage tooltip's "resets in" arithmetic needs it (#68),
     * and it is a parameter for the same reason `scanActiveSessions` takes
     * one: the arithmetic is the policy, so a test must be able to pin it.
     */
    now: number;
}

const STATUS_BAR_PRIORITY_BASE = 900;
const STATUS_BAR_NAME_MAX = 24;
const HIDE_SESSION_COMMAND = 'claudeContextBar.hideSession';

const PASTEL_PALETTE = [
    '#a8d8ea',
    '#d4a5a5',
    '#b5d8c7',
    '#e8d5b7',
    '#c9b1ff',
    '#ffd6a5',
    '#caffbf',
    '#bdb2ff',
    '#ffc6ff',
];

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

/**
 * Describe the whole status bar for one refresh.
 *
 * The array is in display order, leftmost first, and `priority` says the same
 * thing in vscode's own terms: higher sits further left. Session items count
 * down from just above the base so the most recent one is leftmost, leaving
 * the base itself free for the subscription usage item to their right.
 *
 * For now this covers session items only. The subscription usage item and the
 * missing-directory warning still take their old path in the entry point and
 * are folded in by #68.
 *
 * @param facts  This refresh's sessions, Settings snapshot and time
 */
export function describeStatusBar(facts: StatusBarFacts): BarItem[] {
    const { sessions, settings } = facts;

    const displayNames = displayNamesForSessions(sessions, settings);
    const colors = colorsForDisplayNames(displayNames, settings.autoColor, settings.baseColor);

    return sessions.map((session, index) => describeSessionItem(
        session,
        displayNames[index],
        colors.get(displayNames[index]) || '#ffffff',
        sessions.length - index,
        settings,
    ));
}

/**
 * One session's item. The priority it carries is a rank among the session
 * items, offset from the shared base so all three kinds of item sort against
 * one scale.
 */
function describeSessionItem(
    session: SessionInfo,
    displayName: string,
    color: string,
    rank: number,
    settings: Settings,
): BarItem {
    // The emoji is looked up on the un-numbered project name, so a project's
    // second session shows the same emoji as its first.
    const icon = settings.showEmoji ? emojiForProject(session.baseProjectName) : '';

    return {
        key: session.sessionFile,
        // Note formatTokens rounds to the nearest K, so a status bar reading
        // tokens can sit half a K either side of the threshold that colours it.
        text: formatStatusBarText(icon, displayName, formatTokens(session.totalTokens)),
        color,
        background: getContextTokenLevel(
            session.totalTokens,
            settings.warningTokens,
            settings.dangerTokens,
        ),
        tooltip: buildSessionTooltip(session),
        command: {
            command: HIDE_SESSION_COMMAND,
            title: 'Hide Session',
            arguments: [session.sessionFile],
        },
        priority: STATUS_BAR_PRIORITY_BASE + rank,
    };
}

// Fuzzy emoji matching based on project name
function emojiForProject(projectName: string): string {
    const name = projectName.toLowerCase();

    // Emoji mappings with keywords
    const emojiMap: [string[], string][] = [
        // Music & Audio
        [['music', 'audio', 'sound', 'song', 'beat', 'dj', 'ableton', 'daw', 'synth', 'midi', 'tone', 'rhythm'], '🎵'],
        // Games
        [['game', 'play', 'unity', 'unreal', 'godot', 'arcade', 'puzzle'], '🎮'],
        // Web & Frontend
        [['web', 'website', 'frontend', 'react', 'vue', 'angular', 'html', 'css', 'ui', 'ux'], '🌐'],
        // Backend & API
        [['api', 'backend', 'server', 'rest', 'graphql', 'microservice'], '⚙️'],
        // Mobile
        [['mobile', 'ios', 'android', 'app', 'flutter', 'react-native', 'swift', 'kotlin'], '📱'],
        // Data & ML
        [['data', 'ml', 'ai', 'machine', 'learning', 'model', 'train', 'neural', 'tensor'], '🤖'],
        // Database
        [['database', 'db', 'sql', 'mongo', 'postgres', 'mysql', 'redis'], '🗄️'],
        // DevOps & Cloud
        [['devops', 'cloud', 'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'k8s', 'deploy'], '☁️'],
        // Security
        [['security', 'auth', 'crypto', 'encrypt', 'password', 'oauth'], '🔐'],
        // Testing
        [['test', 'spec', 'jest', 'mocha', 'cypress', 'selenium'], '🧪'],
        // Documentation
        [['doc', 'docs', 'readme', 'wiki', 'guide', 'tutorial'], '📚'],
        // Tools & Extensions
        [['tool', 'extension', 'plugin', 'vscode', 'editor'], '🔧'],
        // Chat & Communication
        [['chat', 'message', 'slack', 'discord', 'bot'], '💬'],
        // Finance
        [['finance', 'money', 'payment', 'bank', 'crypto', 'trade'], '💰'],
        // Health
        [['health', 'medical', 'fitness', 'workout'], '❤️'],
        // E-commerce
        [['shop', 'store', 'ecommerce', 'cart', 'product'], '🛒'],
        // Media & Video
        [['video', 'stream', 'youtube', 'media', 'film', 'movie'], '🎬'],
        // Art & Design
        [['art', 'design', 'draw', 'paint', 'sketch', 'creative', 'graphic'], '🎨'],
    ];

    for (const [keywords, emoji] of emojiMap) {
        for (const keyword of keywords) {
            if (name.includes(keyword)) {
                return emoji;
            }
        }
    }

    // Default brain emoji for coding/AI projects
    return '🧠';
}

// Extract the last syllable from a word for compact naming
// "typescript" → "script", "webpack" → "pack", "frontend" → "tend"
function extractLastSyllable(word: string): string {
    // Find a consonant cluster followed by vowel(s) followed by optional consonants at the end
    // This captures common syllable patterns like "tron", "script", "pack"
    const match = word.match(/[bcdfghjklmnpqrstvwxz]+[aeiou]+[bcdfghjklmnpqrstvwxz]*$/i);
    if (match) {
        return match[0];
    }
    // Fallback: just return last 3-4 chars
    return word.slice(-Math.min(4, word.length));
}

// Generate a short name for a project
// Multi-word: "my-cool-project" → "MCP" (acronym)
// Single-word: "typescript" → "Tscript" (first letter + last syllable)
// Short names (≤5 chars) are kept as-is
// Session numbers (-2, -3) are preserved
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

function truncateLabel(text: string, max: number = STATUS_BAR_NAME_MAX): string {
    const t = text.trim();
    if (t.length <= max) {
        return t;
    }
    if (max <= 1) {
        return '…';
    }
    return t.slice(0, max - 1).trimEnd() + '…';
}

function formatTokens(tokens: number): string {
    if (tokens >= 1_000_000) {
        return (tokens / 1_000_000).toFixed(1) + 'M';
    }
    if (tokens >= 1000) {
        return Math.round(tokens / 1000) + 'K';
    }
    return tokens.toString();
}

function formatStatusBarText(icon: string, displayName: string, usageValue: string): string {
    const iconSpace = icon ? ' ' : '';
    return `${icon}${iconSpace}${displayName}: ${usageValue}`;
}

/**
 * First duplicate stays unsuffixed; later copies get -2, -3, matching the
 * existing project-name numbering.
 */
function disambiguateNames(names: string[]): string[] {
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

function resolveDisplayName(opts: {
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

/**
 * The name each session's item is labelled with. Numbering is only applied in
 * `session` mode: in `project` mode the scan has already numbered the project
 * names it hands over.
 */
function displayNamesForSessions(sessions: SessionInfo[], settings: Settings): string[] {
    const { label, compactMode, shortNames } = settings;
    const raw = sessions.map(session => resolveDisplayName({
        label,
        projectName: session.projectName,
        baseProjectName: session.baseProjectName,
        sessionTitle: session.sessionTitle,
        compactProjectName: compactMode ? getShortName(session.projectName, shortNames) : session.projectName,
    }));
    if (label === 'session') {
        return disambiguateNames(raw);
    }
    return raw;
}

/**
 * A colour per display name, taken from the palette in order of first
 * appearance. Keyed on the name rather than the session, so two sessions that
 * end up labelled the same share one colour.
 */
function colorsForDisplayNames(names: string[], autoColor: boolean, baseColor: string): Map<string, string> {
    const palette = autoColor ? PASTEL_PALETTE : (BASE_COLOR_VARIATIONS[baseColor] || BASE_COLOR_VARIATIONS['White']);
    const map = new Map<string, string>();
    let colorIndex = 0;
    for (const name of names) {
        if (!map.has(name)) {
            map.set(name, palette[colorIndex % palette.length]);
            colorIndex++;
        }
    }
    return map;
}

function buildSessionTooltip(session: SessionInfo): string {
    const titleLine = session.sessionTitle ? `🏷️ **${session.sessionTitle}**\n\n` : '';
    // The parser truncates without an ellipsis; adding it is presentation.
    const firstMsgLine = session.firstMessage ? `💬 *"${session.firstMessage}..."*\n\n` : '';
    return (
        `**${session.projectName}** (${session.sessionId})\n\n` +
        titleLine +
        firstMsgLine +
        `📁 \`${session.projectPath}\`\n\n` +
        `🤖 Model: \`${session.model || 'Unknown'}\`\n\n` +
        `📊 **Context Usage: ${session.percentage}%** (${formatTokens(session.totalTokens)})\n\n` +
        `| Type | Tokens |\n|------|--------|\n` +
        `| Cache Read | ${formatTokens(session.cacheReadTokens)} |\n` +
        `| Cache Creation | ${formatTokens(session.cacheCreationTokens)} |\n` +
        `| **Total** | **${formatTokens(session.totalTokens)}** / ${formatTokens(session.contextLimit)} |\n\n` +
        `🕐 Last updated: ${session.lastUpdated.toLocaleTimeString()}\n\n` +
        `*Click to hide*`
    );
}
