import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ContextTokenLevel } from './contextThreshold';
import { getUsage, UsageData } from './usage';
import { scanActiveSessions, SessionFiles, SessionInfo } from './sessions';
import {
    claudeProjectsDir,
    hasExplicitConfigDir,
    readProcessEnv,
    resolveClaudeConfigDir,
} from './configDir';
import { readSettings, Settings } from './settings';
import { BarItem, describeStatusBar, StatusBarFacts } from './statusBar';

/** The vscode items now on the bar, keyed by their Bar item `key`. */
const statusBarItems: Map<string, vscode.StatusBarItem> = new Map();
// Track manually hidden sessions: sessionFile -> timestamp when hidden
const hiddenSessions: Map<string, number> = new Map();
let fileWatcher: fs.FSWatcher | null = null;
let watchedDir: string | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

// The subscription usage last fetched, handed to `describeStatusBar` as one of
// this refresh's facts. Null when the setting is off or nothing arrived yet.
let usageData: UsageData | null = null;
let usageTimer: NodeJS.Timeout | null = null;

/** The facts a refresh has to go to disk for; the rest of one costs nothing. */
type ScanFacts = Pick<
    StatusBarFacts,
    'sessions' | 'projectsDir' | 'projectsDirMissing' | 'configDirExplicit'
>;

/**
 * What the last scan found, kept so a usage tick can redraw without one.
 *
 * `describeStatusBar` describes the whole bar and the caller disposes whatever
 * it leaves out, so there is no usage-only render to call any more: putting a
 * new usage percentage on the bar means describing the session items and the
 * directory warning alongside it. Scanning again to get them would move a read
 * of every session file onto the usage timer, which the usage tick never did —
 * so it describes from these instead, and the scan stays on the paths that
 * always ran it. Null only before the first refresh, which activation runs
 * before any usage fetch can settle.
 */
let lastScan: ScanFacts | null = null;

/** How many session items the status bar will show before it stops. */
const MAX_STATUS_BAR_SESSIONS = 5;

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
            statusBarItems.forEach(item => item.dispose());
            statusBarItems.clear();
        }
    });
}

export function deactivate() {
    closeFileWatcher();
    clearTimers();
    statusBarItems.forEach(item => item.dispose());
    statusBarItems.clear();
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
        listProjectDirs: () => orFallback(
            () => fs.readdirSync(projectsDir).filter(name => isDirectory(path.join(projectsDir, name))),
            [],
        ),
        listSessionFiles: (projectDir) => orFallback(
            () => fs.readdirSync(path.join(projectsDir, projectDir)),
            [],
        ),
        mtimeOf: (projectDir, fileName) => orFallback(
            () => fs.statSync(path.join(projectsDir, projectDir, fileName)).mtime.getTime(),
            null,
        ),
        readText: (projectDir, fileName) => orFallback(
            () => fs.readFileSync(path.join(projectsDir, projectDir, fileName), 'utf-8'),
            null,
        ),
    };
}

/**
 * One `fs` read with the port's no-throw promise kept: what the read answers,
 * or `fallback` when it throws.
 *
 * Written once so that a fifth method added to `SessionFiles` cannot quietly
 * forget it. The fallback is what that method's return type already documents
 * as "could not read" — `[]` or `null` — so each adapter method reads as the
 * one line of `fs` it is, with its failure answer beside it.
 */
function orFallback<T, F>(read: () => T, fallback: F): T | F {
    try {
        return read();
    } catch {
        return fallback;
    }
}

/**
 * Whether one path is a directory, an unreadable entry counting as not one.
 *
 * Per entry rather than around the whole listing: one entry the process may
 * not stat — a stale symlink, a directory it lacks permission on — must skip
 * only itself and leave the rest of the projects listed.
 */
function isDirectory(fullPath: string): boolean {
    return orFallback(() => fs.statSync(fullPath).isDirectory(), false);
}

/**
 * The sessions to render this refresh: what the scan found, ordered for the
 * bar, with the user's hidden ones removed and the list cut to size.
 *
 * Display selection, not display: what those sessions then look like is
 * `describeStatusBar`'s. Which sessions count at all —
 * the idle cutoff, the exclusions, the percentages, the Superseded rules —
 * lives behind `scanActiveSessions`, which is handed this window's Settings
 * snapshot and the current time rather than reaching for either itself.
 */
function findActiveSessions(settings: Settings, projectsDir: string): SessionInfo[] {
    const activeSessions = scanActiveSessions(
        projectsDir,
        settings,
        nodeSessionFiles(projectsDir),
        Date.now(),
    );

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

    return visibleSessions.slice(0, MAX_STATUS_BAR_SESSIONS);
}

/**
 * The one place a Bar item's background level becomes a vscode colour.
 */
function themeBackground(level: ContextTokenLevel): vscode.ThemeColor | undefined {
    if (level === 'danger') {
        return new vscode.ThemeColor('statusBarItem.errorBackground');
    }
    if (level === 'warning') {
        return new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    return undefined;
}

/**
 * Make the bar match a refresh's Bar items: create what is new, update what is
 * reused, dispose what is no longer described. No display decision is taken
 * here — every value applied comes from `describeStatusBar`, and the only work
 * left is turning three of them into vscode's types.
 *
 * A reused item keeps the priority it was created with, as it always has:
 * `StatusBarItem.priority` is fixed at creation, so honouring a changed one
 * would mean disposing and recreating the item. Left alone deliberately.
 */
function syncBarItems(descriptions: BarItem[]) {
    for (const description of descriptions) {
        let item = statusBarItems.get(description.key);
        if (!item) {
            item = vscode.window.createStatusBarItem(
                vscode.StatusBarAlignment.Right,
                description.priority,
            );
            statusBarItems.set(description.key, item);
        }

        item.text = description.text;
        item.color = description.color;
        item.backgroundColor = themeBackground(description.background);
        item.tooltip = new vscode.MarkdownString(description.tooltip);
        item.command = description.command;
        item.show();
    }

    const described = new Set(descriptions.map(description => description.key));
    for (const [key, item] of statusBarItems) {
        if (!described.has(key)) {
            item.dispose();
            statusBarItems.delete(key);
        }
    }
}

/**
 * One refresh: gather this window's facts, ask what the bar should look like,
 * and make it look like that.
 *
 * Every trigger that could have changed what a scan would find comes through
 * here — the session timer, the file watcher, the focus and configuration
 * listeners, the hide command — so all three kinds of item are described
 * together and none of them can be left behind by a path that forgot about it.
 * A finished usage fetch is the one trigger that goes to `renderBar` instead,
 * having changed nothing on disk.
 */
function refreshAllSessions() {
    const settings = currentSettings();
    ensureFileWatcher(settings);

    const projectsDir = getClaudeProjectsDir(settings);
    lastScan = {
        sessions: findActiveSessions(settings, projectsDir),
        projectsDir,
        // The one `fs` question the statusBar module refuses to ask itself.
        projectsDirMissing: !fs.existsSync(projectsDir),
        configDirExplicit: hasExplicitConfigDir(settings.configDir, readProcessEnv()),
    };
    renderBar(settings);
}

/**
 * Draw the bar from the last scan's facts and this snapshot, without scanning.
 *
 * The usage path's whole render: a finished fetch changes the usage number and
 * nothing a scan would answer, so it redraws from what the last refresh
 * already found. Before that first refresh there is no bar to draw and this
 * does nothing; the refresh that follows reads `usageData` and picks it up.
 */
function renderBar(settings: Settings) {
    if (!lastScan) {
        return;
    }
    syncBarItems(describeStatusBar({
        ...lastScan,
        usage: usageData,
        settings,
        now: Date.now(),
    }));
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
        renderBar(settings);
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
        renderBar(settled);
        return;
    }

    // Keep the last successful value on a transient failure rather than flicker.
    if (fetched) {
        usageData = fetched;
    }
    renderBar(settled);
}
