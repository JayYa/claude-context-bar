/**
 * Session-record parsing: JSONL lines in, a Transcript value out.
 *
 * The seam sits on the line array rather than on a file path so the parser is
 * a pure synchronous function with no I/O: reading the file is the caller's
 * job. See `Transcript` for what the value carries.
 */

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

/** What a Transcript looks like before any line has been read. */
const NOTHING_PARSED: Transcript = {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    model: '',
    firstMessage: '',
    sessionCreated: null,
    wasCleared: false,
    lineCount: 0,
    skippedLines: 0,
    clearIndex: -1,
};

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
        return NOTHING_PARSED;
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
            sessionCreated = new Date(entry.timestamp);
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
