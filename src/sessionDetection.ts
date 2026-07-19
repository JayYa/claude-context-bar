import * as fs from 'fs';
import * as path from 'path';
import { getLatestTokenCount, decodeProjectPath } from './sessionFile';
import { getContextLimitForModel } from './contextLimit';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Unified session snapshot with 15 fields covering both extension.ts
 * (status bar display) and debug.ts (diagnostic output) requirements.
 */
export interface SessionInfo {
    projectName: string;
    projectPath: string;
    sessionId: string;
    sessionFile: string;
    inputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    totalTokens: number;
    /** Context usage as a percentage (0–100, may exceed 100 for over-limit). */
    percentage: number;
    lastUpdated: Date;
    model: string;
    contextLimit: number;
    firstMessage: string;
    sessionCreated: Date | null;
    wasCleared: boolean;
}

/**
 * Configuration for session detection.
 *
 * - `idleTimeout`  seconds of inactivity before hiding a session
 * - `contextLimit`  fallback context window size for unknown models
 * - `modelContextLimits`  per-model overrides (exact Model ID match)
 */
export interface DetectionOptions {
    idleTimeout: number;
    contextLimit: number;
    modelContextLimits: Record<string, number>;
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Detect active Claude Code sessions from a Claude projects directory.
 *
 * Returns deduplicated, ghost-session-filtered, stably-numbered, time-sorted
 * session snapshots. Zero VS Code API dependency — pure filesystem + domain logic.
 *
 * Ghost sessions are:
 *   - Cleared sessions (ended with /clear, no post-clear activity)
 *   - Superseded sessions (a newer session was created after this one's last update)
 *
 * Stable numbering: within each project, the oldest active session keeps the
 * bare project name; subsequent sessions append "-2", "-3", etc.
 *
 * @param claudeDir  Path to the Claude projects directory (e.g. ~/.claude/projects)
 * @param options    Detection configuration
 * @returns          Active sessions sorted by lastUpdated descending
 */
export async function detectSessions(
    claudeDir: string,
    options: DetectionOptions,
): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = [];

    if (!fs.existsSync(claudeDir)) {
        return sessions;
    }

    const cutoffTime = Date.now() - (options.idleTimeout * 1000);

    let projectDirs: string[];
    try {
        projectDirs = fs.readdirSync(claudeDir);
    } catch {
        return sessions;
    }

    for (const projectDir of projectDirs) {
        const projectPath = path.join(claudeDir, projectDir);

        let stat: fs.Stats;
        try {
            stat = fs.statSync(projectPath);
        } catch {
            continue;
        }
        if (!stat.isDirectory()) continue;

        // Skip Claude internal directories (background agents, not interactive sessions)
        if (projectDir.includes('claude-plugins') || projectDir.includes('claude-mem')) continue;

        let dirEntries: string[];
        try {
            dirEntries = fs.readdirSync(projectPath);
        } catch {
            continue;
        }

        const files = dirEntries
            .filter(f => f.endsWith('.jsonl'))
            // Skip agent files (claude-mem background processes)
            .filter(f => !f.startsWith('agent-'))
            .map(f => {
                const filePath = path.join(projectPath, f);
                return {
                    name: f,
                    path: filePath,
                    mtime: fs.statSync(filePath).mtime,
                };
            })
            .filter(f => f.mtime.getTime() > cutoffTime)
            .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

        if (files.length === 0) continue;

        for (const file of files) {
            const usage = await getLatestTokenCount(file.path);

            if (usage.totalTokens > 0) {
                const { name, fullPath } = decodeProjectPath(projectDir);
                const sessionId = file.name.replace('.jsonl', '').substring(0, 8);
                const sessionContextLimit = getContextLimitForModel(
                    usage.model,
                    options.contextLimit,
                    options.modelContextLimits,
                );

                sessions.push({
                    projectName: name,
                    projectPath: fullPath,
                    sessionId,
                    sessionFile: file.path,
                    inputTokens: usage.inputTokens,
                    cacheReadTokens: usage.cacheReadTokens,
                    cacheCreationTokens: usage.cacheCreationTokens,
                    totalTokens: usage.totalTokens,
                    percentage: Math.round((usage.totalTokens / sessionContextLimit) * 100),
                    lastUpdated: file.mtime,
                    model: usage.model,
                    contextLimit: sessionContextLimit,
                    firstMessage: usage.firstMessage,
                    sessionCreated: usage.sessionCreated,
                    wasCleared: usage.wasCleared,
                });
            }
        }
    }

    return processSessionGroups(sessions);
}

// ============================================================================
// EXPORTED FOR TESTING
// ============================================================================

/** Normalise `sessionCreated` to epoch milliseconds (null → 0). */
function creationTime(s: SessionInfo): number {
    return s.sessionCreated?.getTime() || 0;
}

/**
 * Apply grouping, ghost-session filtering, stable numbering, and time-based
 * sorting to a flat list of session snapshots. Exported so the filtering logic
 * can be unit-tested independently of the filesystem.
 */
export function processSessionGroups(sessions: SessionInfo[]): SessionInfo[] {
    if (sessions.length === 0) return [];

    // Group sessions by base project name (decoded name)
    const projectGroups = new Map<string, SessionInfo[]>();
    for (const session of sessions) {
        const base = session.projectName;
        if (!projectGroups.has(base)) {
            projectGroups.set(base, []);
        }
        projectGroups.get(base)!.push(session);
    }

    const finalSessions: SessionInfo[] = [];

    for (const [baseName, group] of projectGroups) {
        // Sort by session CREATION time (newest first) to identify supersession
        group.sort((a, b) => creationTime(b) - creationTime(a));

        // Filter out cleared and superseded sessions
        const activeSessions: SessionInfo[] = [];

        for (let i = 0; i < group.length; i++) {
            const session = group[i];

            // Ghost: cleared sessions (ended with /clear, no post-clear activity)
            if (session.wasCleared) continue;

            // Ghost: superseded (newer session created after this one's last update)
            let isSuperseded = false;
            for (let j = 0; j < i; j++) {
                const newerSession = group[j];
                if (creationTime(newerSession) > session.lastUpdated.getTime()) {
                    isSuperseded = true;
                    break;
                }
            }

            if (!isSuperseded) {
                activeSessions.push(session);
            }
        }

        // Re-sort by creation time for stable numbering (oldest first)
        activeSessions.sort((a, b) => creationTime(a) - creationTime(b));

        // Apply stable numbering: oldest keeps bare name, subsequent get "-2", "-3"...
        for (let i = 0; i < activeSessions.length; i++) {
            if (i === 0) {
                activeSessions[i].projectName = baseName;
            } else {
                activeSessions[i].projectName = `${baseName}-${i + 1}`;
            }
        }

        finalSessions.push(...activeSessions);
    }

    // Sort by lastUpdated for display (most recent first)
    finalSessions.sort((a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime());

    return finalSessions;
}
