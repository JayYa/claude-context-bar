import * as vscode from 'vscode';
import * as fs from 'fs';
import { getClaudeProjectsDir } from './sessionFile';
import { detectSessions, DetectionOptions } from './sessionDetection';
import { StatusBarConfig, StatusBarManager } from './statusBarManager';

let fileWatcher: fs.FSWatcher | null = null;
let refreshInterval: NodeJS.Timeout | null = null;
let manager: StatusBarManager;

export function activate(context: vscode.ExtensionContext) {
    console.log('Claude Context Bar is now active');

    manager = new StatusBarManager();

    // Register command to hide a session (triggered by clicking status bar item)
    const hideCommand = vscode.commands.registerCommand('claudeContextBar.hideSession', (sessionFile: string) => {
        manager.hideSession(sessionFile);
    });
    context.subscriptions.push(hideCommand);

    // Listen for configuration changes and refresh immediately
    const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('claudeContextBar')) {
            refreshAllSessions();
        }
    });
    context.subscriptions.push(configWatcher);

    // Initial scan
    refreshAllSessions();

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

    const statusBarConfig: StatusBarConfig = {
        warningThreshold: config.get<number>('warningThreshold', 50),
        dangerThreshold: config.get<number>('dangerThreshold', 75),
        autoColor: config.get<boolean>('autoColor', true),
        baseColor: config.get<string>('baseColor', 'White'),
        showEmoji: config.get<boolean>('showEmoji', true),
        compactMode: config.get<boolean>('compactMode', false),
    };

    const shortNames = config.get<Record<string, string>>('shortNames', {});

    manager.updateSessions(sessions, statusBarConfig, shortNames);
}
