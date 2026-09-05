/**
 * The Sessions module: a Claude Code projects directory in, the Active
 * sessions the status bar should show out.
 *
 * `scanActiveSessions` is this module's whole interface. Everything that
 * decides which sessions count sits behind it — the idle cutoff, the plugin
 * and agent-file exclusions, transcript parsing, the per-model context limit
 * and the percentage derived from it, and the Superseded session rules — so
 * "an item that should be on the bar isn't" has one place to look.
 *
 * The disk is reached only through the `SessionFiles` port, so a test drives
 * the entire scan from an in-memory directory tree; this module imports
 * neither `vscode` nor `fs`. Until #62 the scan lived in the extension entry
 * point on top of `fs` directly, and none of what it decided was covered.
 *
 * What stays with the caller is display: ordering the result, the cap of five
 * items, the sessions the user has clicked away, and the warning shown when
 * the configured directory is missing. Resolving that directory is its own
 * seam as well — this module is handed the projects directory, already
 * resolved.
 */

import * as path from 'path';

import { getContextLimitForModel } from './contextLimit';
import { decodeProjectPath } from './projectPath';
import { Settings } from './settings';
import { parseTranscript, splitTranscriptLines } from './transcript';

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
 * Reads the session files under one Claude Code projects directory: the one
 * way this module touches the disk.
 *
 * **No method throws.** A directory that cannot be read — including one that
 * does not exist at all — reads as empty, and a file whose mtime or text
 * cannot be read answers `null` so the scan can skip that one file. This is
 * the guarantee that used to live in a `try`/`catch` wrapped around each
 * individual file read: one unreadable session file must never take out the
 * status bar items of the projects the scan had not reached yet. Expressing
 * it in the return types means a caller cannot forget it, and the blast
 * radius is stated where the failure happens instead of where it is caught.
 *
 * Named for what it reads rather than for what it is: `SessionFiles`, not a
 * general `FileStore`. The name says the only thing this seam is allowed to
 * do, and keeps a later "just one more file read" from being tempting.
 *
 * The four methods address files the way the scan thinks about them — a
 * project directory name, then a file name within it — not by path. Path
 * building is the adapter's business, so the in-memory fake is a nested
 * literal and never has to split a string to answer a question. That is also
 * why the port carries no notion of where the projects directory is: the
 * production adapter is bound to one, the fake simply has no such concept.
 */
export interface SessionFiles {
    /** Names of the project directories, or `[]` when there are none to read. */
    listProjectDirs(): string[];
    /** Names of the entries in one project directory, or `[]`. Unfiltered: which
     *  names count as sessions is the scan's decision, not the adapter's. */
    listSessionFiles(projectDir: string): string[];
    /**
     * A file's last-modified time in epoch milliseconds, or `null`.
     *
     * `null` rather than `0` on failure, deliberately. `0` would be a real
     * timestamp and would be compared against the idle cutoff like any other:
     * with `idleTimeout` switched off the cutoff is `0` too, so an unreadable
     * file would flip from being dropped to being kept. The same implicit
     * `0`/`NaN` trap this module warns about around `createdAt`.
     */
    mtimeOf(projectDir: string, fileName: string): number | null;
    /** A file's contents as text, or `null` when it cannot be read. */
    readText(projectDir: string, fileName: string): string | null;
}

/**
 * Project directories whose contents are never sessions of the user's own:
 * plugin and Claude Memory background work, which would otherwise compete for
 * the few slots the status bar has. Matched as substrings, because the
 * encoded directory name carries the whole path these live under.
 */
const EXCLUDED_PROJECT_DIRS: readonly string[] = ['claude-plugins', 'claude-mem'];

/** Session files written by background agents rather than by a user's tab. */
const AGENT_FILE_PREFIX = 'agent-';

const SESSION_FILE_EXTENSION = '.jsonl';

/** How much of a session's UUID file name identifies it in the tooltip. */
const SESSION_ID_LENGTH = 8;

/** A session file that survived the idle cutoff, with the mtime it survived on. */
interface RecentFile {
    name: string;
    mtime: number;
}

/**
 * The moment before which a session counts as idle, in epoch milliseconds.
 *
 * `idleTimeout` of zero or less means "switch this off", the meaning the
 * setting documents, and a cutoff of `0` keeps every file: no real mtime sits
 * at or below the epoch. This is why `now` is a parameter and not something
 * the caller subtracts from — the arithmetic *is* the policy, and a test that
 * places a fixture either side of the cutoff should be exercising the same
 * code the extension runs.
 */
function idleCutoff(idleTimeout: number, now: number): number {
    return idleTimeout > 0 ? now - idleTimeout * 1000 : 0;
}

/** The session files in one project directory that are still in play. */
function recentSessionFiles(files: SessionFiles, projectDir: string, cutoff: number): RecentFile[] {
    return files.listSessionFiles(projectDir)
        .filter(name => name.endsWith(SESSION_FILE_EXTENSION))
        .filter(name => !name.startsWith(AGENT_FILE_PREFIX))
        .map(name => ({ name, mtime: files.mtimeOf(projectDir, name) }))
        // An unreadable mtime drops just this one file. It cannot be compared
        // against the cutoff at all, and any stand-in value would be a guess
        // about how stale the file is — see `SessionFiles`.
        .filter((file): file is RecentFile => file.mtime !== null)
        .filter(file => file.mtime > cutoff)
        // Newest first, and not for the scan's own sake: `selectActiveSessions`
        // sorts on `createdAt` alone, and both of its sorts are stable, so two
        // sessions of one project that tie there — the epoch both an unparseable
        // and a missing creation time read as — keep whatever order the scan
        // pushed them in. That order decides which of them takes the bare
        // project name and which gets the `-2` suffix, so leaving it to the
        // directory listing would make the display name depend on the
        // filesystem. Most recently touched wins the tie instead.
        .sort((a, b) => b.mtime - a.mtime);
}

/**
 * One session file read and parsed, or `null` when it yields nothing to show.
 *
 * Two ways to yield nothing, and they are the same answer here: the port
 * could not read the text at all, or the transcript carries no tokens yet —
 * a session that has not started costing anything gets no slot on the bar.
 */
function readSession(
    projectsDir: string,
    projectDir: string,
    file: RecentFile,
    settings: Settings,
    files: SessionFiles,
): SessionInfo | null {
    const text = files.readText(projectDir, file.name);
    if (text === null) {
        return null;
    }

    const transcript = parseTranscript(splitTranscriptLines(text));
    if (transcript.totalTokens <= 0) {
        return null;
    }

    const { name, fullPath } = decodeProjectPath(projectDir);
    const contextLimit = getContextLimitForModel(
        transcript.model,
        settings.contextLimit,
        settings.modelContextLimits,
    );

    return {
        projectName: name,
        baseProjectName: name,
        sessionTitle: transcript.sessionTitle,
        projectPath: fullPath,
        sessionId: file.name.replace(SESSION_FILE_EXTENSION, '').substring(0, SESSION_ID_LENGTH),
        sessionFile: path.join(projectsDir, projectDir, file.name),
        inputTokens: transcript.inputTokens,
        cacheReadTokens: transcript.cacheReadTokens,
        cacheCreationTokens: transcript.cacheCreationTokens,
        totalTokens: transcript.totalTokens,
        percentage: Math.round((transcript.totalTokens / contextLimit) * 100),
        lastUpdated: new Date(file.mtime),
        model: transcript.model,
        contextLimit,
        firstMessage: transcript.firstMessage,
        sessionCreated: transcript.sessionCreated,
        wasCleared: transcript.wasCleared,
    };
}

/**
 * The Active sessions under `projectsDir`, each with its display name, its
 * own model's context limit and the percentage of it consumed.
 *
 * Synchronous. Every read goes through the port and the port is synchronous,
 * so the `async` this replaced never had anything to await; no Promise is
 * kept back for a hypothetical asynchronous `fs`.
 *
 * Takes the whole Settings snapshot rather than the three fields it reads
 * today. That is what a snapshot is for — CONTEXT.md defines it as one
 * refresh's values passed down by parameter — and the next setting the scan
 * needs will not change this signature.
 *
 * A missing projects directory needs no check of its own: it lists as empty,
 * and no projects means no sessions.
 *
 * Return order is grouping order, not display order: ordering the result and
 * capping it belong to the caller. See `selectActiveSessions`.
 *
 * @param projectsDir  Claude Code's projects directory, already resolved
 * @param settings     The snapshot for this refresh
 * @param files        The port to read through
 * @param now          This refresh's time, in epoch milliseconds
 */
export function scanActiveSessions(
    projectsDir: string,
    settings: Settings,
    files: SessionFiles,
    now: number,
): SessionInfo[] {
    const cutoff = idleCutoff(settings.idleTimeout, now);
    const scanned: SessionInfo[] = [];

    for (const projectDir of files.listProjectDirs()) {
        if (EXCLUDED_PROJECT_DIRS.some(excluded => projectDir.includes(excluded))) {
            continue;
        }

        for (const file of recentSessionFiles(files, projectDir, cutoff)) {
            const session = readSession(projectsDir, projectDir, file, settings, files);
            if (session) {
                scanned.push(session);
            }
        }
    }

    return selectActiveSessions(scanned);
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
 * Which of the scanned sessions to show, and what to call each one.
 *
 * **An internal seam, not this module's interface.** It is exported for its
 * own tests: the Superseded session rules are precise enough to be worth
 * driving from hand-built `SessionInfo` values rather than through JSONL
 * fixtures. Callers outside this module use `scanActiveSessions`, which ends
 * by calling this; #62 removed the last outside import.
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
