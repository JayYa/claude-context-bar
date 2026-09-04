/**
 * Project path decoding: one of Claude Code's encoded directory names in, the
 * project's display name and its real path out.
 *
 * Claude Code names a project's folder after the path it was opened at, with
 * every separator flattened to a dash — `C:\dev\my-cool-project` becomes
 * `C--dev-my-cool-project`, `/Users/ed/work/app` becomes `-Users-ed-work-app`.
 * The encoding is lossy: a dash in the encoded name is a separator *or* a dash
 * the folder was really named with, and nothing distinguishes the two. What
 * comes back out is therefore a guess, not a decode, and the guess is what the
 * status bar shows and what its tooltip claims the path is.
 *
 * That ambiguity is why this lives in its own module with its own tests rather
 * than inside the scan: the heuristic has edges worth pinning down on their
 * own. It stays off the Sessions module's interface — only the scan calls it —
 * and it imports neither `vscode` nor `fs`, being pure string work.
 */

/** A project as the status bar knows it: what to call it, and where it is. */
export interface ProjectPath {
    /**
     * The name to display. Never empty: an encoded name that yields no
     * segments at all decodes to `Unknown`, so the status bar item stays
     * readable and clickable instead of collapsing to blank.
     */
    name: string;
    /** The reconstructed absolute path, shown in the tooltip. */
    fullPath: string;
}

/**
 * How many trailing segments a project name may be built from.
 *
 * A deeply nested path would otherwise put its whole chain on the status bar.
 * Three is a compromise with the lossy encoding: a folder really named
 * `my-cool-project` arrives as three segments, so taking fewer would truncate
 * such names, and taking more would start pulling parent directories in.
 */
const NAME_SEGMENTS = 3;

/**
 * The project name and real path behind one encoded directory name.
 *
 * Segments are read off the encoded name and the leading separator's empty
 * segment dropped, which also swallows the doubled dash Windows uses for the
 * colon. A single-letter first segment is read as a drive letter and the path
 * rebuilt Windows-style; anything else is treated as a Unix absolute path.
 *
 * The name is then the last few segments rejoined with dashes — the same
 * character they were split on, so a folder whose name genuinely contains
 * dashes survives the round trip. Only the drive letter and the first folder
 * are skipped, so a shallow path still yields its own last segment rather
 * than nothing.
 */
export function decodeProjectPath(encodedName: string): ProjectPath {
    let decoded = encodedName;

    if (decoded.startsWith('-')) {
        decoded = decoded.substring(1);
    }

    const parts = decoded.split('-').filter(p => p.length > 0);
    let fullPath: string;

    // A one-letter first segment is taken as a drive letter. Nothing in the
    // encoding marks a Windows name as such, and a real folder named `a` at the
    // root of a Unix path would be read the same way; that path is rare enough
    // to be worth trading for recognising every Windows project.
    if (parts.length > 0 && parts[0].length === 1 && /[a-zA-Z]/.test(parts[0])) {
        fullPath = parts[0].toUpperCase() + ':\\' + parts.slice(1).join('\\');
    } else {
        fullPath = '/' + parts.join('/');
    }

    return { name: projectNameFrom(parts), fullPath };
}

/**
 * The display name for a path's segments.
 *
 * Windows and Unix share this: the drive letter and `Users`/`home` sit in the
 * same first two slots, so both want the same "skip the prefix, keep the tail"
 * rule. `Math.max` is what keeps the two bounds from crossing on a path that
 * is deep enough to need trimming but whose prefix would otherwise be kept.
 */
function projectNameFrom(parts: string[]): string {
    if (parts.length >= NAME_SEGMENTS) {
        const startIndex = Math.max(2, parts.length - NAME_SEGMENTS);
        return parts.slice(startIndex).join('-');
    }
    return parts[parts.length - 1] || 'Unknown';
}
