import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getContextLimitForModel } from './contextLimit';
import { getContextTokenLevel } from './contextThreshold';
import { getUsage, UsageData, UsageMeter } from './usage';
import { parseTranscript, splitTranscriptLines } from './transcript';
import { selectActiveSessions, SessionInfo } from './sessions';
import {
    claudeProjectsDir,
    hasExplicitConfigDir,
    readProcessEnv,
    resolveClaudeConfigDir,
} from './configDir';
import {
    disambiguateNames,
    formatStatusBarText,
    formatTokens,
    formatUsageValue,
    resolveDisplayName,
    StatusBarLabel,
    UsageFormat,
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
let refreshInterval: NodeJS.Timeout | null = null;

// Subscription usage shown in a single
// status bar item to the right of the per-tab context items.
let usageItem: vscode.StatusBarItem | null = null;
let usageData: UsageData | null = null;
let usageInterval: NodeJS.Timeout | null = null;

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
            ensureFileWatcher();
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
    const config = vscode.workspace.getConfiguration('claudeContextBar');
    const intervalSeconds = config.get<number>('refreshInterval', 30);
    refreshInterval = setInterval(refreshAllSessions, intervalSeconds * 1000);
    const usageIntervalSeconds = config.get<number>('usageRefreshInterval', 60);
    usageInterval = setInterval(refreshUsageData, usageIntervalSeconds * 1000);

    // Clean up on deactivation
    context.subscriptions.push({
        dispose: () => {
            closeFileWatcher();
            if (refreshInterval) {
                clearInterval(refreshInterval);
            }
            if (usageInterval) {
                clearInterval(usageInterval);
            }
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
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }
    if (usageInterval) {
        clearInterval(usageInterval);
    }
    statusBarItems.forEach(entry => entry.item.dispose());
    statusBarItems.clear();
    usageItem?.dispose();
    usageItem = null;
    missingDirItem?.dispose();
    missingDirItem = null;
}

function readConfigDirSetting(): string {
    return vscode.workspace.getConfiguration('claudeContextBar').get<string>('configDir', '') ?? '';
}

function getClaudeConfigDir(): string {
    return resolveClaudeConfigDir({
        setting: readConfigDirSetting(),
        env: readProcessEnv(),
        homedir: os.homedir(),
    });
}

function getClaudeProjectsDir(): string {
    return claudeProjectsDir(getClaudeConfigDir());
}

function closeFileWatcher() {
    if (fileWatcher) {
        fileWatcher.close();
        fileWatcher = null;
    }
    watchedDir = null;
}

function ensureFileWatcher() {
    const dir = getClaudeProjectsDir();
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

function updateMissingDirItem() {
    const projectsDir = getClaudeProjectsDir();
    const explicit = hasExplicitConfigDir(readConfigDirSetting(), readProcessEnv());
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

function decodeProjectPath(encodedName: string): { name: string; fullPath: string } {
    // Claude encodes paths like: C--dev-my-cool-project or -Users-name-work-my-project
    // The double-dash after drive letter represents the colon (C: -> C--)
    // Single dashes represent path separators, BUT folder names can also contain dashes
    // 
    // Strategy: Detect OS from the pattern and reconstruct path
    let decoded = encodedName;

    // Remove leading dash if present
    if (decoded.startsWith('-')) {
        decoded = decoded.substring(1);
    }

    // Split by dashes and filter out empty strings (from double-dashes)
    const parts = decoded.split('-').filter(p => p.length > 0);
    let fullPath: string;
    let projectName: string;

    // Check if Windows pattern (first part is single drive letter like 'c', 'd', etc.)
    if (parts.length > 0 && parts[0].length === 1 && /[a-zA-Z]/.test(parts[0])) {
        // Windows path: C:\dev\my-cool-project
        // Claude typically encodes as: C--dev-my-cool-project
        // After filtering empty strings: ['C', 'dev', 'my', 'cool', 'project']
        fullPath = parts[0].toUpperCase() + ':\\' + parts.slice(1).join('\\');

        // Project name: use last few segments only (not full path chain)
        // For C:\dev\webapp -> parts = ['C', 'dev', 'webapp'] -> projectName = 'webapp'
        // For C:\dev\tools\extensions\vscode\my-extension -> use last 3 parts -> 'my-extension'
        if (parts.length >= 3) {
            // Skip drive letter and first folder, but limit to last 3 segments for deeply nested paths
            const startIndex = Math.max(2, parts.length - 3);
            const projectParts = parts.slice(startIndex);
            projectName = projectParts.join('-');
        } else {
            projectName = parts[parts.length - 1] || 'Unknown';
        }
    } else {
        // Unix path: /Users/Ed/work/my-project
        fullPath = '/' + parts.join('/');

        // Similar heuristic for Unix
        if (parts.length >= 3) {
            // Skip common prefixes like Users, home, etc.
            const projectParts = parts.slice(Math.max(2, parts.length - 3));
            projectName = projectParts.join('-');
        } else {
            projectName = parts[parts.length - 1] || 'Unknown';
        }
    }

    return { name: projectName, fullPath };
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

async function findActiveSessions(): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = [];
    const claudeDir = getClaudeProjectsDir();

    if (!fs.existsSync(claudeDir)) {
        return sessions;
    }

    const config = vscode.workspace.getConfiguration('claudeContextBar');
    const contextLimit = config.get<number>('contextLimit', 200000);
    const modelContextLimits = config.get<Record<string, number>>('modelContextLimits', {});
    const idleTimeout = config.get<number>('idleTimeout', 180);

    // Only look at sessions modified within the idle timeout (active sessions)
    // idleTimeout of 0 (or negative) disables the timeout: sessions never go stale
    const cutoffTime = idleTimeout > 0 ? Date.now() - (idleTimeout * 1000) : 0;

    try {
        const projectDirs = fs.readdirSync(claudeDir);

        for (const projectDir of projectDirs) {
            const projectPath = path.join(claudeDir, projectDir);
            const stat = fs.statSync(projectPath);

            if (!stat.isDirectory()) continue;

            // Skip Claude Memory and plugin directories (background agents, not interactive sessions)
            if (projectDir.includes('claude-plugins') || projectDir.includes('claude-mem')) continue;

            // Find JSONL files modified within cutoff time
            const files = fs.readdirSync(projectPath)
                .filter(f => f.endsWith('.jsonl'))
                // Skip agent files (claude-mem background processes)
                .filter(f => !f.startsWith('agent-'))
                .map(f => ({
                    name: f,
                    path: path.join(projectPath, f),
                    mtime: fs.statSync(path.join(projectPath, f)).mtime
                }))
                .filter(f => f.mtime.getTime() > cutoffTime)
                .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

            if (files.length === 0) continue;

            // Get token count from EACH active session file (1 per Claude Code tab)
            for (const file of files) {
                // Read inside its own try/catch: the outer try around the whole
                // scan would catch a read failure too, but it would also abandon
                // every project still unvisited, wiping their status bar items.
                // Catching here keeps the blast radius at this one session.
                let lines: string[];
                try {
                    lines = splitTranscriptLines(fs.readFileSync(file.path, 'utf-8'));
                } catch {
                    continue;
                }

                const transcript = parseTranscript(lines);

                if (transcript.totalTokens > 0) {
                    const { name, fullPath } = decodeProjectPath(projectDir);
                    // Extract short session ID from filename
                    const sessionId = file.name.replace('.jsonl', '').substring(0, 8);
                    // Auto-detect context limit based on model
                    const sessionContextLimit = getContextLimitForModel(transcript.model, contextLimit, modelContextLimits);
                    sessions.push({
                        projectName: name,
                        baseProjectName: name,
                        sessionTitle: transcript.sessionTitle,
                        projectPath: fullPath,
                        sessionId,
                        sessionFile: file.path,
                        inputTokens: transcript.inputTokens,
                        cacheReadTokens: transcript.cacheReadTokens,
                        cacheCreationTokens: transcript.cacheCreationTokens,
                        totalTokens: transcript.totalTokens,
                        percentage: Math.round((transcript.totalTokens / sessionContextLimit) * 100),
                        lastUpdated: file.mtime,
                        model: transcript.model,
                        contextLimit: sessionContextLimit,
                        firstMessage: transcript.firstMessage,
                        sessionCreated: transcript.sessionCreated,
                        wasCleared: transcript.wasCleared
                    });
                }
            }
        }
    } catch (e) {
        console.error('Error scanning Claude projects:', e);
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
    usageFormat: UsageFormat,
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
        formatUsageValue(session.percentage, session.totalTokens, usageFormat),
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
    ensureFileWatcher();
    updateMissingDirItem();

    const sessions = await findActiveSessions();
    const config = vscode.workspace.getConfiguration('claudeContextBar');
    const warningTokens = config.get<number>('warningTokens', 120000);
    const dangerTokens = config.get<number>('dangerTokens', 150000);
    const displayNames = displayNamesForSessions(
        sessions,
        config.get<StatusBarLabel>('label', 'project'),
        config.get<boolean>('compactMode', false),
        config.get<Record<string, string>>('shortNames', {}),
    );
    const colorMap = colorsForDisplayNames(
        displayNames,
        config.get<boolean>('autoColor', true),
        config.get<string>('baseColor', 'White'),
    );
    const showEmoji = config.get<boolean>('showEmoji', true);
    const usageFormat = config.get<UsageFormat>('usageFormat', 'tokens');
    const seenPaths = new Set<string>();

    for (let i = 0; i < sessions.length; i++) {
        renderSessionItem(
            sessions[i],
            i,
            sessions.length,
            displayNames[i],
            colorMap.get(displayNames[i]) || '#ffffff',
            showEmoji,
            usageFormat,
            warningTokens,
            dangerTokens,
            seenPaths,
        );
    }

    pruneStaleItems(seenPaths);
    renderUsageItem();
}

// Render the single global usage item (e.g. "✴️ 7%") to the right of the context items.
function renderUsageItem() {
    const config = vscode.workspace.getConfiguration('claudeContextBar');
    const showUsage = config.get<boolean>('showUsage', false);

    if (!showUsage || !usageData?.session) {
        usageItem?.dispose();
        usageItem = null;
        return;
    }

    const warningThreshold = config.get<number>('usageWarningThreshold', 50);
    const dangerThreshold = config.get<number>('usageDangerThreshold', 75);

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
    const config = vscode.workspace.getConfiguration('claudeContextBar');
    const showUsage = config.get<boolean>('showUsage', false);

    if (!showUsage) {
        usageData = null;
        renderUsageItem();
        return;
    }

    // The usage endpoint rate-limits aggressive polling; never overlap calls.
    if (usageFetchInFlight) {
        return;
    }
    usageFetchInFlight = true;
    try {
        const fetched = await getUsage(getClaudeCodeVersion(), getClaudeConfigDir());
        // Keep the last successful value on a transient failure rather than flicker.
        if (fetched) {
            usageData = fetched;
        }
    } catch (e) {
        console.error('Failed to fetch Claude usage:', e);
    } finally {
        usageFetchInFlight = false;
    }

    renderUsageItem();
}
