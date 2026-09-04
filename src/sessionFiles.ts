/**
 * The `SessionFiles` port: the one way the session scan touches the disk.
 *
 * The scan used to call `fs` directly, which meant no part of it — the idle
 * cutoff, the excluded directories, the per-model percentages — could be
 * exercised without a real Claude config directory on the machine running the
 * tests. Behind this port a test drives the whole scan from an in-memory
 * directory tree.
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

/**
 * Reads the session files under one Claude Code projects directory.
 *
 * **No method throws.** A directory that cannot be read — including one that
 * does not exist at all — reads as empty, and a file whose mtime or text
 * cannot be read answers `null` so the scan can skip that one file. This is
 * the guarantee that used to live in a `try`/`catch` wrapped around each
 * individual file read: one unreadable session file must never take out the
 * status bar items of the projects the scan had not reached yet. Expressing
 * it in the return types means a caller cannot forget it, and the blast
 * radius is stated where the failure happens instead of where it is caught.
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
     * `0`/`NaN` trap the Sessions module warns about around `createdAt`.
     */
    mtimeOf(projectDir: string, fileName: string): number | null;
    /** A file's contents as text, or `null` when it cannot be read. */
    readText(projectDir: string, fileName: string): string | null;
}
