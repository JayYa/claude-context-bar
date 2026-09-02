/**
 * Session-record parsing: JSONL lines in, a Transcript value out.
 *
 * The seam sits on the line array rather than on a file path so the parser is
 * a pure synchronous function with no I/O: reading the file is the caller's
 * job. See `Transcript` for what the value carries.
 */

import { pickSessionTitle, readTitleFromEntry } from './statusBarText';

/**
 * Everything one Claude Code session file says about its conversation.
 *
 * The shape is deliberately flat. It is *not* named `TokenUsage`: it carries
 * the first user message and timestamps too, and "usage" is already taken by
 * the account-level subscription usage this extension also displays. Keeping
 * the two words apart is a rule in CONTEXT.md.
 */
export interface Transcript {
    /** Input tokens from the last usage record. */
    inputTokens: number;
    /** Cache read tokens from the last usage record. */
    cacheReadTokens: number;
    /** Cache creation tokens from the last usage record. */
    cacheCreationTokens: number;
    /** Sum of the three above. Derived, but kept: four call sites need it. */
    totalTokens: number;
    /** Last model ID seen, or '' if none was recorded. */
    model: string;
    /**
     * First displayable user message, truncated to 60 characters and with no
     * ellipsis: the ellipsis is presentation and belongs to the tooltip.
     */
    firstMessage: string;
    /**
     * The session's own title, or '' when Claude Code has not written one.
     *
     * Read from the `custom-title` and `ai-title` entries in the counted
     * region, a user-chosen name winning over the generated summary.
     */
    sessionTitle: string;
    /** First timestamp in the counted region, or null if there is none. */
    sessionCreated: Date | null;
    /** True when the conversation ends on a `/clear` with nothing after it. */
    wasCleared: boolean;
    /** Lines handed in, blank ones included. */
    lineCount: number;
    /** Lines that failed to parse as JSON. Blank lines do not count. */
    skippedLines: number;
    /** Index of the last `/clear` line, or -1 when there is none. */
    clearIndex: number;
}

/** How much of the first user message the tooltip has room for. */
const FIRST_MESSAGE_LENGTH = 60;

const CLEAR_MARKER = '<command-name>/clear</command-name>';

/**
 * What a Transcript looks like when no line yielded anything.
 *
 * A fresh object each call, never a shared constant: callers own what they
 * get back. `lineCount` still reports how much was handed in, so "empty
 * session" and "unreadable file" stay distinguishable even here.
 */
function nothingParsed(lineCount: number): Transcript {
    return {
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 0,
        model: '',
        firstMessage: '',
        sessionTitle: '',
        sessionCreated: null,
        wasCleared: false,
        lineCount,
        skippedLines: 0,
        clearIndex: -1,
    };
}

/**
 * Parse JSONL session-record lines into a Transcript.
 *
 * Never throws. A line that is not valid JSON is skipped and counted in
 * `skippedLines`; an entry whose shape is unexpected simply contributes
 * nothing. Whatever the input, the return value is a valid Transcript.
 *
 * Counting starts *after* the last `/clear`, because that is where the
 * conversation the user is looking at begins.
 *
 * @param lines  The session file's lines, blank ones included
 * @returns      A valid Transcript, always
 */
export function parseTranscript(lines: readonly string[]): Transcript {
    try {
        return parse(lines);
    } catch {
        // The guarantee is unconditional: callers render whatever comes back,
        // so a surprise here has to degrade to "nothing parsed", not throw.
        return nothingParsed(lines.length);
    }
}

function parse(lines: readonly string[]): Transcript {
    // One JSON pass over the whole file. Both scans below read these entries,
    // so a corrupt line is counted once no matter which side of the /clear it
    // falls on. An `undefined` entry is a blank or unparseable line.
    let skippedLines = 0;
    const entries: any[] = lines.map((line) => {
        if (!line || !line.trim()) {
            return undefined;
        }
        try {
            return JSON.parse(line);
        } catch {
            skippedLines++;
            return undefined;
        }
    });

    // Backward scan for the last /clear, counting user messages seen on the
    // way: those all sit after the /clear, since we are walking up to it.
    let clearIndex = -1;
    let userMessagesAfterClear = 0;

    for (let i = entries.length - 1; i >= 0; i--) {
        const content = userContent(entries[i]);
        if (content === undefined) {
            continue;
        }
        if (typeof content === 'string' && content.includes(CLEAR_MARKER)) {
            clearIndex = i;
            break;
        }
        userMessagesAfterClear++;
    }

    // Cleared means: a /clear happened and the user has not typed since.
    const wasCleared = clearIndex !== -1 && userMessagesAfterClear === 0;

    // Forward scan over the live region for metadata and the latest usage.
    const startIndex = clearIndex >= 0 ? clearIndex + 1 : 0;

    let firstMessage = '';
    let customTitle = '';
    let aiTitle = '';
    let sessionCreated: Date | null = null;
    let model = '';
    let inputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;

    for (let i = startIndex; i < entries.length; i++) {
        const entry = entries[i];
        if (entry === undefined || entry === null) {
            continue;
        }

        if (!sessionCreated && entry.timestamp) {
            // A junk timestamp yields an Invalid Date, which is neither a
            // usable date nor null and throws from `toISOString()`. Callers
            // are promised one or the other, so keep null.
            const parsed = new Date(entry.timestamp);
            if (!Number.isNaN(parsed.getTime())) {
                sessionCreated = parsed;
            }
        }

        // Later title entries win: Claude Code appends a new one on `/rename`
        // and when it regenerates the summary.
        const titles = readTitleFromEntry(entry);
        if (titles.customTitle) {
            customTitle = titles.customTitle;
        }
        if (titles.aiTitle) {
            aiTitle = titles.aiTitle;
        }

        if (!firstMessage) {
            firstMessage = displayableMessage(entry);
        }

        if (entry.message?.model) {
            model = entry.message.model;
        }

        // Named `record`, not `usage`: in this codebase Usage means the
        // account-level subscription allowance. `usage` here is only the raw
        // JSONL field name.
        const record = entry.message?.usage || entry.usage;
        if (record) {
            inputTokens = record.input_tokens || 0;
            cacheReadTokens = record.cache_read_input_tokens || 0;
            cacheCreationTokens = record.cache_creation_input_tokens || 0;
        }
    }

    return {
        inputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        totalTokens: inputTokens + cacheReadTokens + cacheCreationTokens,
        model,
        firstMessage,
        sessionTitle: pickSessionTitle(customTitle, aiTitle),
        sessionCreated,
        wasCleared,
        lineCount: lines.length,
        skippedLines,
        clearIndex,
    };
}

/** The `message.content` of a user entry, or undefined if this is not one. */
function userContent(entry: any): unknown {
    if (entry === undefined || entry === null) {
        return undefined;
    }
    if (entry.type !== 'user' || !entry.message?.content) {
        return undefined;
    }
    return entry.message.content;
}

/**
 * The part of an entry worth showing as the conversation's opening line, or
 * '' if there is none.
 *
 * Slash commands and injected preambles are noise, so string content carrying
 * their markers is dropped. The filter is a substring test and applies to the
 * string branch only: array content is shown verbatim, markers and all.
 */
function displayableMessage(entry: any): string {
    const content = userContent(entry);

    if (typeof content === 'string') {
        if (content.includes('<command-name>') ||
            content.includes('<local-command-') ||
            content.includes('Caveat:')) {
            return '';
        }
        return content.substring(0, FIRST_MESSAGE_LENGTH);
    }

    if (Array.isArray(content) && typeof content[0]?.text === 'string') {
        return content[0].text.substring(0, FIRST_MESSAGE_LENGTH);
    }

    return '';
}

/**
 * Split a session file's contents into the lines `parseTranscript` expects.
 *
 * The terminating newline is dropped before splitting: it would otherwise
 * yield a phantom empty last line and inflate `lineCount` by one on every
 * session file. Every adapter that reads a file needs this, so it lives here
 * rather than once per adapter.
 *
 * @param content  A session file's raw contents
 * @returns        One entry per line, blank ones included
 */
export function splitTranscriptLines(content: string): string[] {
    if (content === '') {
        return [];
    }
    return content.replace(/\n$/, '').split('\n');
}
