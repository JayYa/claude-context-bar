import * as vscode from 'vscode';
import * as fs from 'fs';
import { getClaudeProjectsDir } from './sessionFile';
import { detectSessions, DetectionOptions } from './sessionDetection';
import { ContextUsageConfig, ContextUsageManager } from './contextUsageManager';
import { SubscriptionUsageManager, UsageStatusBarConfig } from './subscriptionUsageManager';

let fileWatcher: fs.FSWatcher | null = null;
let refreshInterval: NodeJS.Timeout | null = null;
let manager: ContextUsageManager;
let usageManager: SubscriptionUsageManager;

export function activate(context: vscode.ExtensionContext) {
    console.log('Claude Context Bar is now active');

    manager = new ContextUsageManager();
    usageManager = new SubscriptionUsageManager();

    // Register command to hide a session (triggered by clicking status bar item)
    const hideCommand = vscode.commands.registerCommand('claudeContextBar.hideSession', (sessionFile: string) => {
        manager.hideSession(sessionFile);
    });
    context.subscriptions.push(hideCommand);

    // Listen for configuration changes and refresh immediately
    const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('claudeContextBar')) {
            refreshAllSessions();
            refreshUsage();
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
    startUsageManager();

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

    // Clean up on deactivation
    context.subscriptions.push({
        dispose: () => {
            if (fileWatcher) {
                fileWatcher.close();
            }
            if (refreshInterval) {
                clearInterval(refreshInterval);
            }
            manager.dispose();
            usageManager.dispose();
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
    manager.dispose();
    usageManager.dispose();
}

// Version of the Claude Code extension running in this same IDE, used for the
// usage request's User-Agent. This is the relevant client version (not any CLI on PATH).
function getClaudeCodeVersion(): string | null {
    return vscode.extensions.getExtension('anthropic.claude-code')?.packageJSON?.version ?? null;
}

/** Read subscription usage config from VS Code settings. */
function readUsageConfig(): UsageStatusBarConfig {
    const config = vscode.workspace.getConfiguration('claudeContextBar');
    return {
        showUsage: config.get<boolean>('showUsage', false),
        warningThreshold: config.get<number>('usageWarningThreshold', 50),
        dangerThreshold: config.get<number>('usageDangerThreshold', 75),
        usageRefreshInterval: config.get<number>('usageRefreshInterval', 60),
    };
}

/** Read config and start the subscription usage manager with periodic polling. */
function startUsageManager() {
    usageManager.start(readUsageConfig());
    usageManager.refresh(getClaudeCodeVersion);
}

/** Refresh subscription usage on config change. */
function refreshUsage() {
    usageManager.updateConfig(readUsageConfig());
    usageManager.refresh(getClaudeCodeVersion);
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
}
