/**
 * Active session selection: every parsed session in, the ones the status bar
 * should show out, each carrying its final display name.
 *
 * The seam sits on a plain collection of `SessionInfo` values rather than on
 * the directory scan, so this module imports neither `vscode` nor `fs` and can
 * be driven directly from a test. Finding the files, applying the `mtime`
 * cutoff, excluding plugin and agent directories, reading configuration and
 * resolving per-model context limits all stay with the caller.
 */

/**
 * Everything the status bar knows about one Claude Code session.
 *
 * `projectName` doubles as the display name: `selectActiveSessions` returns
 * values whose `projectName` carries the stable numeric suffix when the
 * project has more than one Active session.
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
    percentage: number;
    lastUpdated: Date;
    model: string;
    contextLimit: number;
    firstMessage: string;
    sessionCreated: Date | null;
    wasCleared: boolean;
}

/**
 * A session with no parseable creation time counts as created at the Unix
 * epoch. That sorts it last within its project and makes it Superseded by
 * almost any sibling. This is today's behaviour, kept deliberately; see #45.
 */
function createdAt(session: SessionInfo): number {
    return session.sessionCreated?.getTime() || 0;
}

/**
 * The Active sessions across every project, each with its display name.
 *
 * Groups by project, drops Superseded sessions, then numbers what survives.
 * The three are one transformation: the suffix a session gets depends on which
 * of its siblings survived the filter.
 *
 * The input is not mutated. Numbering returns new session values, so the same
 * collection can be handed in twice and yield the same answer both times.
 *
 * Return order is grouping order, not display order: sorting for the status
 * bar is the caller's job.
 */
export function selectActiveSessions(sessions: SessionInfo[]): SessionInfo[] {
    const projectGroups = new Map<string, SessionInfo[]>();
    for (const session of sessions) {
        const base = session.projectName;
        if (!projectGroups.has(base)) {
            projectGroups.set(base, []);
        }
        projectGroups.get(base)!.push(session);
    }

    const selected: SessionInfo[] = [];
    for (const [baseName, group] of projectGroups) {
        // Newest first, so a session's possible supersedors are the ones
        // sitting before it.
        const byCreationDesc = [...group].sort((a, b) => createdAt(b) - createdAt(a));

        const active: SessionInfo[] = [];
        for (let i = 0; i < byCreationDesc.length; i++) {
            const session = byCreationDesc[i];

            // Superseded, ground one: ended on a `/clear` with nothing after.
            if (session.wasCleared) {
                continue;
            }

            // Superseded, ground two: a newer session in the same project was
            // created after this one's last update, so the user moved on.
            const displaced = byCreationDesc
                .slice(0, i)
                .some(newer => createdAt(newer) > session.lastUpdated.getTime());

            if (!displaced) {
                active.push(session);
            }
        }

        // Numbering follows creation order, oldest first, so the session
        // started first keeps the bare project name and a newly started one
        // never renames the sessions already on the bar.
        active.sort((a, b) => createdAt(a) - createdAt(b));

        for (let i = 0; i < active.length; i++) {
            selected.push({
                ...active[i],
                projectName: i === 0 ? baseName : `${baseName}-${i + 1}`
            });
        }
    }

    return selected;
}
