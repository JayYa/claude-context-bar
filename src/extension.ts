import * as vscode from 'vscode';
import * as fs from 'fs';
import { getClaudeProjectsDir } from './sessionFile';
import { detectSessions, DetectionOptions } from './sessionDetection';
import { ContextUsageConfig, ContextUsageManager } from './contextUsageManager';
import { getUsage, UsageData, UsageMeter } from './usage';

let fileWatcher: fs.FSWatcher | null = null;
let refreshInterval: NodeJS.Timeout | null = null;
let manager: ContextUsageManager;

// Subscription usage shown in a single
// status bar item to the right of the per-tab context items.
let usageItem: vscode.StatusBarItem | null = null;
let usageData: UsageData | null = null;
let usageInterval: NodeJS.Timeout | null = null;

const STATUS_BAR_PRIORITY_BASE = 900;
const ITEM_CLAUDE_ICON = '✨️';

export function activate(context: vscode.ExtensionContext) {
    console.log('Claude Context Bar is now active');

    manager = new ContextUsageManager();

    // Register command to hide a session (triggered by clicking status bar item)
    const hideCommand = vscode.commands.registerCommand('claudeContextBar.hideSession', (sessionFile: string) => {
        manager.hideSession(sessionFile);
    });
    context.subscriptions.push(hideCommand);

    // Listen for configuration changes and refresh immediately
    const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('claudeContextBar')) {
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

    // Set up file watcher
    const claudeProjectsDir = getClaudeProjectsDir();
    if (fs.existsSync(claudeProjectsDir)) {
        try {
            fileWatcher = fs.watch(claudeProjectsDir, { recursive: true }, (event, filename) => {
                if (filename?.endsWith('.jsonl')) {
                    refreshAllSessions();
                }
            });
        } catch (e) {
            console.error('Failed to set up file watcher:', e);
        }
    }

    // Set up periodic refresh
    const config = vscode.workspace.getConfiguration('claudeContextBar');
    const intervalSeconds = config.get<number>('refreshInterval', 30);
    refreshInterval = setInterval(refreshAllSessions, intervalSeconds * 1000);
    const usageIntervalSeconds = config.get<number>('usageRefreshInterval', 60);
    usageInterval = setInterval(refreshUsageData, usageIntervalSeconds * 1000);

    // Clean up on deactivation
    context.subscriptions.push({
        dispose: () => {
            if (fileWatcher) {
                fileWatcher.close();
            }
            if (refreshInterval) {
                clearInterval(refreshInterval);
            }
            if (usageInterval) {
                clearInterval(usageInterval);
            }
            manager.dispose();
            usageItem?.dispose();
            usageItem = null;
        }
    });
}

export function deactivate() {
    if (fileWatcher) {
        fileWatcher.close();
    }
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }
    if (usageInterval) {
        clearInterval(usageInterval);
    }
    manager.dispose();
    usageItem?.dispose();
    usageItem = null;
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

    if (session.percentage >= dangerThreshold) {
        usageItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (session.percentage >= warningThreshold) {
        usageItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        usageItem.backgroundColor = undefined;
    }

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
        const fetched = await getUsage(getClaudeCodeVersion());
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

async function refreshAllSessions() {
    const claudeDir = getClaudeProjectsDir();
    const config = vscode.workspace.getConfiguration('claudeContextBar');

    const detectionOptions: DetectionOptions = {
        idleTimeout: config.get<number>('idleTimeout', 180),
        contextLimit: config.get<number>('contextLimit', 200000),
        modelContextLimits: config.get<Record<string, number>>('modelContextLimits', {}),
    };

    const sessions = await detectSessions(claudeDir, detectionOptions);

    const contextUsageConfig: ContextUsageConfig = {
        warningThreshold: config.get<number>('warningThreshold', 50),
        dangerThreshold: config.get<number>('dangerThreshold', 75),
        autoColor: config.get<boolean>('autoColor', true),
        baseColor: config.get<string>('baseColor', 'White'),
        showEmoji: config.get<boolean>('showEmoji', true),
        compactMode: config.get<boolean>('compactMode', false),
    };

    const shortNames = config.get<Record<string, string>>('shortNames', {});

    manager.updateSessions(sessions, contextUsageConfig, shortNames);

    // Render the usage item to the right of the context items.
    renderUsageItem();
}
