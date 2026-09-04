import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getContextLimitForModel } from './contextLimit';
import { getContextTokenLevel } from './contextThreshold';
import { getUsage, UsageData, UsageMeter } from './usage';
import { parseTranscript, splitTranscriptLines } from './transcript';
import { selectActiveSessions, SessionInfo } from './sessions';
import { decodeProjectPath } from './projectPath';
import { SessionFiles } from './sessionFiles';
import {
    claudeProjectsDir,
    hasExplicitConfigDir,
    readProcessEnv,
    resolveClaudeConfigDir,
} from './configDir';
import { readSettings, Settings } from './settings';
import {
    disambiguateNames,
    formatStatusBarText,
    formatTokens,
    resolveDisplayName,
    StatusBarLabel,
} from './statusBarText';

interface StatusBarEntry {
    item: vscode.StatusBarItem;
    sessionFile: string;
}

const statusBarItems: Map<string, StatusBarEntry> = new Map();
// Track manually hidden sessions: sessionFile -> timestamp when hidden
const hiddenSessions: Map<string, number> = new Map();
let fileWatcher: fs.FSWatcher | null = null;
let watchedDir: string | null = null;
let missingDirItem: vscode.StatusBarItem | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

// Subscription usage shown in a single
// status bar item to the right of the per-tab context items.
let usageItem: vscode.StatusBarItem | null = null;
let usageData: UsageData | null = null;
let usageTimer: NodeJS.Timeout | null = null;

const STATUS_BAR_PRIORITY_BASE = 900;
const ITEM_CLAUDE_ICON = '✴️';

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
 * The extension's single point of contact with VS Code's settings: every other
 * function receives the resulting snapshot as a parameter. Called once per
 * refresh (and again whenever a setting changes), never cached in a module-level
 * variable — a snapshot's life is one refresh.
 */
function currentSettings(): Settings {
    return readSettings(vscode.workspace.getConfiguration('claudeContextBar'));
}

/**
 * Stops both polling timers and forgets their handles. Every place that
 * tears the timers down — reinstall, dispose, deactivate — goes through here,
 * so none of them can drop one of the pair.
 */
function clearTimers() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }
    if (usageTimer) {
        clearInterval(usageTimer);
        usageTimer = null;
    }
}

/**
 * Installs both polling timers from a snapshot, clearing any existing ones
 * first so a reinstall never leaves a second timer running. Activation and the
 * configuration watcher both go through here, so the two paths cannot drift.
 */
function installTimers(settings: Settings) {
    clearTimers();
    refreshTimer = setInterval(refreshAllSessions, settings.refreshInterval * 1000);
    usageTimer = setInterval(refreshUsageData, settings.usageRefreshInterval * 1000);
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Claude Context Bar is now active');

    // Register command to hide a session (triggered by clicking status bar item)
    const hideCommand = vscode.commands.registerCommand('claudeContextBar.hideSession', (sessionFile: string) => {
        hiddenSessions.set(sessionFile, Date.now());
        // Immediately refresh to hide the item
        refreshAllSessions();
    });
    context.subscriptions.push(hideCommand);

    // Listen for configuration changes and refresh immediately
    const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('claudeContextBar')) {
            const settings = currentSettings();
            ensureFileWatcher(settings);
            // Unconditional reinstall: a changed interval takes effect at once,
            // with no "did the interval change?" test to keep in sync.
            installTimers(settings);
            refreshAllSessions();
            refreshUsageData();
        }
    });
    context.subscriptions.push(configWatcher);

    // Rescan when the window regains focus so returning to a session
    // restores its bar as soon as fresh activity lands in the session file
    const focusWatcher = vscode.window.onDidChangeWindowState(state => {
        if (state.focused) {
            refreshAllSessions();
        }
    });
    context.subscriptions.push(focusWatcher);

    // Initial scan
    refreshAllSessions();
    refreshUsageData();

    // Set up periodic refresh
    installTimers(currentSettings());

    // Clean up on deactivation
    context.subscriptions.push({
        dispose: () => {
            closeFileWatcher();
            clearTimers();
            statusBarItems.forEach(entry => entry.item.dispose());
            statusBarItems.clear();
            usageItem?.dispose();
            usageItem = null;
            missingDirItem?.dispose();
            missingDirItem = null;
        }
    });
}

export function deactivate() {
    closeFileWatcher();
    clearTimers();
    statusBarItems.forEach(entry => entry.item.dispose());
    statusBarItems.clear();
    usageItem?.dispose();
    usageItem = null;
    missingDirItem?.dispose();
    missingDirItem = null;
}

function getClaudeConfigDir(settings: Settings): string {
    return resolveClaudeConfigDir({
        setting: settings.configDir,
        env: readProcessEnv(),
        homedir: os.homedir(),
    });
}

function getClaudeProjectsDir(settings: Settings): string {
    return claudeProjectsDir(getClaudeConfigDir(settings));
}

function closeFileWatcher() {
    if (fileWatcher) {
        fileWatcher.close();
        fileWatcher = null;
    }
    watchedDir = null;
}

function ensureFileWatcher(settings: Settings) {
    const dir = getClaudeProjectsDir(settings);
    if (fileWatcher && watchedDir === dir) {
        return;
    }
    closeFileWatcher();
    if (!fs.existsSync(dir)) {
        return;
    }
    try {
        fileWatcher = fs.watch(dir, { recursive: true }, (_event: string, filename: unknown) => {
            if (typeof filename === 'string' && filename.endsWith('.jsonl')) {
                refreshAllSessions();
            }
        });
        watchedDir = dir;
    } catch (e) {
        console.error('Failed to set up file watcher:', e);
    }
}

function updateMissingDirItem(settings: Settings) {
    const projectsDir = getClaudeProjectsDir(settings);
    const explicit = hasExplicitConfigDir(settings.configDir, readProcessEnv());
    const missing = !fs.existsSync(projectsDir);
    if (!explicit || !missing) {
        missingDirItem?.dispose();
        missingDirItem = null;
        return;
    }
    if (!missingDirItem) {
        missingDirItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            STATUS_BAR_PRIORITY_BASE + 10,
        );
    }
    missingDirItem.text = '⚠️ Claude config dir';
    missingDirItem.tooltip = new vscode.MarkdownString(
        `Claude Context Bar could not find \`${projectsDir}\`.\n\n` +
        `Set \`claudeContextBar.configDir\` to your Claude config folder (the one that contains \`projects/\`), ` +
        `or set the \`CLAUDE_CONFIG_DIR\` environment variable.`
    );
    missingDirItem.show();
}

// Fuzzy emoji matching based on project name
function getEmojiForProject(projectName: string): string {
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
// Short names (≤3 chars) are kept as-is
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

/**
 * Node's `fs` behind the `SessionFiles` port, bound to one projects directory.
 *
 * An object literal in the extension entry point rather than a module of its
 * own: this is the last inch of the wiring, and the entry point is already
 * where this extension's contact with `fs` and `vscode` is supposed to live.
 * Every method swallows its errors, because the port promises not to throw —
 * see `SessionFiles` for why that promise is worth more than the exception.
 */
function nodeSessionFiles(projectsDir: string): SessionFiles {
    return {
        listProjectDirs() {
            try {
                return fs.readdirSync(projectsDir).filter(name => {
                    try {
                        return fs.statSync(path.join(projectsDir, name)).isDirectory();
                    } catch {
                        return false;
                    }
                });
            } catch {
                return [];
            }
        },
        listSessionFiles(projectDir) {
            try {
                return fs.readdirSync(path.join(projectsDir, projectDir));
            } catch {
                return [];
            }
        },
        mtimeOf(projectDir, fileName) {
            try {
                return fs.statSync(path.join(projectsDir, projectDir, fileName)).mtime.getTime();
            } catch {
                return null;
            }
        },
        readText(projectDir, fileName) {
            try {
                return fs.readFileSync(path.join(projectsDir, projectDir, fileName), 'utf-8');
            } catch {
                return null;
            }
        },
    };
}

async function findActiveSessions(settings: Settings): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = [];
    const claudeDir = getClaudeProjectsDir(settings);
    const files = nodeSessionFiles(claudeDir);

    const { contextLimit, modelContextLimits, idleTimeout } = settings;

    // Only look at sessions modified within the idle timeout (active sessions)
    // idleTimeout of 0 (or negative) disables the timeout: sessions never go stale
    const cutoffTime = idleTimeout > 0 ? Date.now() - (idleTimeout * 1000) : 0;

    // A missing projects directory needs no check of its own: it lists as empty,
    // and an empty list of projects yields an empty status bar.
    const projectDirs = files.listProjectDirs();

    for (const projectDir of projectDirs) {
        // Skip Claude Memory and plugin directories (background agents, not interactive sessions)
        if (projectDir.includes('claude-plugins') || projectDir.includes('claude-mem')) continue;

        // Find JSONL files modified within cutoff time
        const entries = files.listSessionFiles(projectDir)
            .filter(f => f.endsWith('.jsonl'))
            // Skip agent files (claude-mem background processes)
            .filter(f => !f.startsWith('agent-'))
            .map(f => ({ name: f, mtime: files.mtimeOf(projectDir, f) }))
            // An unreadable mtime drops just this one file. It cannot be
            // compared against the cutoff at all, and any stand-in value would
            // be a guess about how stale the file is — see `SessionFiles`.
            .filter((f): f is { name: string; mtime: number } => f.mtime !== null)
            .filter(f => f.mtime > cutoffTime)
            .sort((a, b) => b.mtime - a.mtime);

        if (entries.length === 0) continue;

        // Get token count from EACH active session file (1 per Claude Code tab)
        for (const entry of entries) {
            // A file that will not read is skipped rather than raised: the port
            // answers with no text instead of throwing, which is what keeps one
            // bad session file from abandoning every project the scan has not
            // reached yet and wiping their status bar items.
            const text = files.readText(projectDir, entry.name);
            if (text === null) continue;

            const transcript = parseTranscript(splitTranscriptLines(text));

            if (transcript.totalTokens > 0) {
                const { name, fullPath } = decodeProjectPath(projectDir);
                // Extract short session ID from filename
                const sessionId = entry.name.replace('.jsonl', '').substring(0, 8);
                // Auto-detect context limit based on model
                const sessionContextLimit = getContextLimitForModel(transcript.model, contextLimit, modelContextLimits);
                sessions.push({
                    projectName: name,
                    baseProjectName: name,
                    sessionTitle: transcript.sessionTitle,
                    projectPath: fullPath,
                    sessionId,
                    sessionFile: path.join(claudeDir, projectDir, entry.name),
                    inputTokens: transcript.inputTokens,
                    cacheReadTokens: transcript.cacheReadTokens,
                    cacheCreationTokens: transcript.cacheCreationTokens,
                    totalTokens: transcript.totalTokens,
                    percentage: Math.round((transcript.totalTokens / sessionContextLimit) * 100),
                    lastUpdated: new Date(entry.mtime),
                    model: transcript.model,
                    contextLimit: sessionContextLimit,
                    firstMessage: transcript.firstMessage,
                    sessionCreated: transcript.sessionCreated,
                    wasCleared: transcript.wasCleared
                });
            }
        }
    }

    // Which of the scanned sessions to show, and what to call each one.
    const activeSessions = selectActiveSessions(sessions);

    // Sort by mtime for display order (most recent first)
    activeSessions.sort((a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime());

    // Filter out manually hidden sessions, but auto-unhide if there's new activity
    const visibleSessions = activeSessions.filter(session => {
        const hiddenAt = hiddenSessions.get(session.sessionFile);
        if (hiddenAt) {
            // Check if session was modified after it was hidden
            if (session.lastUpdated.getTime() > hiddenAt) {
                // New activity! Remove from hidden list
                hiddenSessions.delete(session.sessionFile);
                return true; // Show it
            }
            return false; // Still hidden
        }
        return true; // Not hidden
    });

    return visibleSessions.slice(0, 5);
}

function displayNamesForSessions(
    sessions: SessionInfo[],
    label: StatusBarLabel,
    compactMode: boolean,
    shortNames: Record<string, string>,
): string[] {
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

/**
 * Background for the subscription usage item, driven by a percentage.
 *
 * Only the subscription item uses this: the `/usage` endpoint reports nothing
 * but a percentage, so there is no token count to threshold against. Context
 * items go through `applyContextBackground` instead.
 */
function applyUsageBackground(
    item: vscode.StatusBarItem,
    percentage: number,
    warningThreshold: number,
    dangerThreshold: number,
) {
    if (percentage >= dangerThreshold) {
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (percentage >= warningThreshold) {
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        item.backgroundColor = undefined;
    }
}

/**
 * Background for a context item, driven by absolute token consumption rather
 * than a percentage of the window. See `getContextTokenLevel` for why.
 */
function applyContextBackground(
    item: vscode.StatusBarItem,
    totalTokens: number,
    warningTokens: number,
    dangerTokens: number,
) {
    const level = getContextTokenLevel(totalTokens, warningTokens, dangerTokens);
    if (level === 'danger') {
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (level === 'warning') {
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        item.backgroundColor = undefined;
    }
}

function buildSessionTooltip(session: SessionInfo): vscode.MarkdownString {
    const titleLine = session.sessionTitle ? `🏷️ **${session.sessionTitle}**\n\n` : '';
    // The parser truncates without an ellipsis; adding it is presentation.
    const firstMsgLine = session.firstMessage ? `💬 *"${session.firstMessage}..."*\n\n` : '';
    return new vscode.MarkdownString(
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

function renderSessionItem(
    session: SessionInfo,
    index: number,
    sessionCount: number,
    displayName: string,
    color: string,
    showEmoji: boolean,
    warningTokens: number,
    dangerTokens: number,
    seenPaths: Set<string>,
) {
    seenPaths.add(session.sessionFile);
    let entry = statusBarItems.get(session.sessionFile);
    if (!entry) {
        const priority = STATUS_BAR_PRIORITY_BASE + (sessionCount - index);
        const item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            priority
        );
        entry = { item, sessionFile: session.sessionFile };
        statusBarItems.set(session.sessionFile, entry);
    }

    const icon = showEmoji ? getEmojiForProject(session.baseProjectName) : '';
    entry.item.text = formatStatusBarText(
        icon,
        displayName,
        formatTokens(session.totalTokens),
    );
    // Note formatTokens rounds to the nearest K, so a status bar reading
    // tokens can sit half a K either side of the threshold that colours it.
    applyContextBackground(entry.item, session.totalTokens, warningTokens, dangerTokens);
    entry.item.color = color;
    entry.item.tooltip = buildSessionTooltip(session);
    entry.item.command = {
        command: 'claudeContextBar.hideSession',
        title: 'Hide Session',
        arguments: [session.sessionFile]
    };
    entry.item.show();
}

function pruneStaleItems(seenPaths: Set<string>) {
    for (const [sessionFile, entry] of statusBarItems) {
        if (!seenPaths.has(sessionFile)) {
            entry.item.dispose();
            statusBarItems.delete(sessionFile);
        }
    }
}

async function refreshAllSessions() {
    const settings = currentSettings();
    ensureFileWatcher(settings);
    updateMissingDirItem(settings);

    const sessions = await findActiveSessions(settings);
    const { warningTokens, dangerTokens, showEmoji } = settings;
    const displayNames = displayNamesForSessions(
        sessions,
        settings.label,
        settings.compactMode,
        settings.shortNames,
    );
    const colorMap = colorsForDisplayNames(
        displayNames,
        settings.autoColor,
        settings.baseColor,
    );
    const seenPaths = new Set<string>();

    for (let i = 0; i < sessions.length; i++) {
        renderSessionItem(
            sessions[i],
            i,
            sessions.length,
            displayNames[i],
            colorMap.get(displayNames[i]) || '#ffffff',
            showEmoji,
            warningTokens,
            dangerTokens,
            seenPaths,
        );
    }

    pruneStaleItems(seenPaths);
    renderUsageItem(settings);
}

// Render the single global usage item (e.g. "✴️ 7%") to the right of the context items.
function renderUsageItem(settings: Settings) {
    // No usage data means nothing to show. `showUsage` is judged only in
    // `refreshUsageData`, which clears `usageData` when the setting is off —
    // so this one condition covers both "switched off" and "not fetched yet".
    if (!usageData?.session) {
        usageItem?.dispose();
        usageItem = null;
        return;
    }

    const { usageWarningThreshold: warningThreshold, usageDangerThreshold: dangerThreshold } = settings;

    if (!usageItem) {
        // Priority just below the context items (which start at 901) so this
        // sits immediately to their right, still left of Claude Code's own items.
        usageItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, STATUS_BAR_PRIORITY_BASE);
    }

    const session = usageData.session;
    usageItem.text = `${ITEM_CLAUDE_ICON} ${session.percentage}%`;
    applyUsageBackground(usageItem, session.percentage, warningThreshold, dangerThreshold);

    usageItem.tooltip = buildUsageTooltip(usageData);
    usageItem.show();
}

function formatReset(resetsAt: Date | null): string {
    if (!resetsAt) {
        return '';
    }
    const msLeft = resetsAt.getTime() - Date.now();
    if (msLeft <= 0) {
        return ' — resetting';
    }
    const hours = Math.floor(msLeft / 3_600_000);
    const days = Math.floor(hours / 24);
    const rel = days >= 1 ? `${days}d` : hours >= 1 ? `${hours}h` : `${Math.max(1, Math.round(msLeft / 60_000))}m`;
    return ` — resets in ${rel}`;
}

function buildUsageTooltip(data: UsageData): vscode.MarkdownString {
    const rows = data.meters
        .map((m: UsageMeter) => `| ${m.label} | **${m.percentage}%** | ${formatReset(m.resetsAt).replace(/^ — /, '')} |`)
        .join('\n');

    return new vscode.MarkdownString(
        `⚡ **Claude Usage**\n\n` +
        `| Limit | Used | Resets |\n|------|------|------|\n` +
        rows +
        `\n\n*Subscription rate limits (\`/usage\`)*`
    );
}

let usageFetchInFlight = false;

// Version of the Claude Code extension running in this same IDE, used for the
// usage request's User-Agent. This is the relevant client version (not any CLI on PATH).
function getClaudeCodeVersion(): string | null {
    return vscode.extensions.getExtension('anthropic.claude-code')?.packageJSON?.version ?? null;
}

async function refreshUsageData() {
    const settings = currentSettings();

    // The one place `showUsage` is judged: it gates both the fetch and, by way
    // of clearing `usageData`, whether the item is shown at all.
    if (!settings.showUsage) {
        usageData = null;
        renderUsageItem(settings);
        return;
    }

    // The usage endpoint rate-limits aggressive polling; never overlap calls.
    if (usageFetchInFlight) {
        return;
    }
    usageFetchInFlight = true;
    let fetched: UsageData | null = null;
    try {
        fetched = await getUsage(getClaudeCodeVersion(), getClaudeConfigDir(settings));
    } catch (e) {
        console.error('Failed to fetch Claude usage:', e);
    } finally {
        usageFetchInFlight = false;
    }

    // The await gave the user time to switch `showUsage` off, which would have
    // hidden the item already; the snapshot this call started with still says
    // on. Judge the setting again — still here, still the only place — against a
    // fresh snapshot, so a result that arrives after the switch is dropped
    // rather than bringing the item back until the next tick.
    const settled = currentSettings();
    if (!settled.showUsage) {
        usageData = null;
        renderUsageItem(settled);
        return;
    }

    // Keep the last successful value on a transient failure rather than flicker.
    if (fetched) {
        usageData = fetched;
    }
    renderUsageItem(settled);
}
