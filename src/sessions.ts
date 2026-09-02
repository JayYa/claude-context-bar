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
    /**
     * The project's name without any numeric suffix, kept alongside
     * `projectName` for the parts of the display that must not see the
     * numbering: the emoji lookup and the fallback when a session has no
     * title. `selectActiveSessions` never rewrites it.
     */
    baseProjectName: string;
    /** The Claude Code session title, or '' when none has been written. */
    sessionTitle: string;
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
 * A session's creation time as a comparable number, a missing one reading as
 * the Unix epoch: the oldest a session can be. Intended, not incidental.
 *
 * The state is unreachable through this extension's own parser. A scanned
 * session is only shown once it carries tokens, which takes a usage-bearing
 * entry in the live region, and the creation-time scan reads that same region,
 * accepting a timestamp from any entry in it. Across 13,094 real session-file
 * entries, every usage-bearing entry carried a valid timestamp and none carried
 * a malformed one. The epoch is chosen for the day that stops being true:
 * unknown-is-oldest degrades safely, since such a session is readily Superseded
 * rather than displacing real ones, which is what unknown-is-newest would do.
 * The accepted cost sits in the numbering, where an unknown creation time takes
 * the bare project name from a sibling that really is older.
 *
 * `||`, not `??`: `selectActiveSessions` is an exported seam, and its
 * `Date | null` admits an Invalid Date from a caller other than the parser:
 * a real `Date` whose `getTime()` is `NaN`. `??` would let that through, and
 * every comparison against it would silently go false. A session genuinely
 * stamped 1970-01-01T00:00:00Z collapses to `0` too, which is the right answer
 * for it.
 *
 * Decided in #45.
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
