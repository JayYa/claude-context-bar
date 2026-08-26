import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseTranscript, splitTranscriptLines, Transcript } from './transcript';

// --- fixtures ---------------------------------------------------------------
//
// Fixtures are arrays of JSONL lines, the shape the parser takes directly.
// `line()` keeps them readable; a fixture may also hold a hand-written string,
// e.g. a corrupt line.

function line(entry: unknown): string {
    return JSON.stringify(entry);
}

function userLine(content: unknown, extra: Record<string, unknown> = {}): string {
    return line({ type: 'user', message: { content }, ...extra });
}

function assistantLine(usage: Record<string, unknown>, model?: string): string {
    const message: Record<string, unknown> = { usage };
    if (model) {
        message.model = model;
    }
    return line({ type: 'assistant', message });
}

const CLEAR_LINE = userLine('<command-name>/clear</command-name>');

// A transcript the parser found nothing in: no tokens, no model, no message.
function assertNothingParsed(transcript: Transcript): void {
    assert.equal(transcript.inputTokens, 0);
    assert.equal(transcript.cacheReadTokens, 0);
    assert.equal(transcript.cacheCreationTokens, 0);
    assert.equal(transcript.totalTokens, 0);
    assert.equal(transcript.model, '');
    assert.equal(transcript.firstMessage, '');
    assert.equal(transcript.sessionCreated, null);
    assert.equal(transcript.wasCleared, false);
}

// --- tests ------------------------------------------------------------------

describe('parseTranscript — basic parsing', () => {
    it('reports an empty transcript as all zeros', () => {
        assertNothingParsed(parseTranscript([]));
    });

    it('reports a blank-lines-only transcript as all zeros', () => {
        assertNothingParsed(parseTranscript(['', '   ', '\t', '']));
    });

    it('takes the last usage record when several are present', () => {
        const transcript = parseTranscript([
            assistantLine({ input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 }),
            assistantLine({ input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 }),
        ]);

        assert.equal(transcript.inputTokens, 1);
        assert.equal(transcript.cacheReadTokens, 2);
        assert.equal(transcript.cacheCreationTokens, 3);
    });

    it('totals input, cache read and cache creation tokens', () => {
        const transcript = parseTranscript([
            assistantLine({ input_tokens: 100, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 30_000 }),
        ]);

        assert.equal(transcript.totalTokens, 32_100);
    });

    it('treats missing usage fields as zero', () => {
        const transcript = parseTranscript([assistantLine({ input_tokens: 100 })]);

        assert.equal(transcript.cacheReadTokens, 0);
        assert.equal(transcript.cacheCreationTokens, 0);
        assert.equal(transcript.totalTokens, 100);
    });

    it('takes the last model id seen', () => {
        const transcript = parseTranscript([
            assistantLine({ input_tokens: 1 }, 'claude-sonnet-5'),
            assistantLine({ input_tokens: 2 }, 'claude-opus-5'),
        ]);

        assert.equal(transcript.model, 'claude-opus-5');
    });

    it('reads usage from a top-level `usage` field', () => {
        const transcript = parseTranscript([
            line({ type: 'assistant', usage: { input_tokens: 7, cache_read_input_tokens: 8, cache_creation_input_tokens: 9 } }),
        ]);

        assert.equal(transcript.totalTokens, 24);
    });

    it('reads usage from a nested `message.usage` field', () => {
        const transcript = parseTranscript([
            line({ type: 'assistant', message: { usage: { input_tokens: 7, cache_read_input_tokens: 8, cache_creation_input_tokens: 9 } } }),
        ]);

        assert.equal(transcript.totalTokens, 24);
    });

    it('prefers `message.usage` over a top-level `usage` on the same entry', () => {
        const transcript = parseTranscript([
            line({
                type: 'assistant',
                usage: { input_tokens: 1 },
                message: { usage: { input_tokens: 500 } },
            }),
        ]);

        assert.equal(transcript.inputTokens, 500);
    });

    it('takes the session creation time from the first timestamped entry', () => {
        const transcript = parseTranscript([
            userLine('hello', { timestamp: '2026-07-12T10:00:00.000Z' }),
            assistantLine({ input_tokens: 1 }),
            line({ type: 'assistant', timestamp: '2026-07-12T11:00:00.000Z' }),
        ]);

        assert.deepEqual(transcript.sessionCreated, new Date('2026-07-12T10:00:00.000Z'));
    });
});

describe('parseTranscript — /clear semantics', () => {
    it('is cleared when no user message follows the /clear', () => {
        const transcript = parseTranscript([
            userLine('hello'),
            assistantLine({ input_tokens: 5_000 }),
            CLEAR_LINE,
        ]);

        assert.equal(transcript.wasCleared, true);
    });

    it('is not cleared when a user message follows the /clear', () => {
        const transcript = parseTranscript([
            userLine('hello'),
            assistantLine({ input_tokens: 5_000 }),
            CLEAR_LINE,
            userLine('back again'),
        ]);

        assert.equal(transcript.wasCleared, false);
    });

    it('counts only what comes after the /clear', () => {
        const transcript = parseTranscript([
            userLine('before the clear'),
            assistantLine({ input_tokens: 5_000 }, 'claude-sonnet-5'),
            CLEAR_LINE,
            userLine('after the clear'),
            assistantLine({ input_tokens: 42 }, 'claude-opus-5'),
        ]);

        assert.equal(transcript.inputTokens, 42);
        assert.equal(transcript.totalTokens, 42);
        assert.equal(transcript.model, 'claude-opus-5');
        assert.equal(transcript.firstMessage, 'after the clear');
    });

    it('a transcript with no /clear counts from the top', () => {
        const transcript = parseTranscript([
            userLine('hello'),
            assistantLine({ input_tokens: 5_000 }),
        ]);

        assert.equal(transcript.wasCleared, false);
        assert.equal(transcript.totalTokens, 5_000);
        assert.equal(transcript.firstMessage, 'hello');
    });

    it('the last /clear wins when there are several', () => {
        const transcript = parseTranscript([
            userLine('first round'),
            CLEAR_LINE,
            userLine('second round'),
            assistantLine({ input_tokens: 5_000 }),
            CLEAR_LINE,
            userLine('third round'),
            assistantLine({ input_tokens: 42 }),
        ]);

        assert.equal(transcript.wasCleared, false);
        assert.equal(transcript.totalTokens, 42);
        assert.equal(transcript.firstMessage, 'third round');
    });
});

describe('parseTranscript — first message', () => {
    it('reads string content', () => {
        const transcript = parseTranscript([userLine('what does this do?')]);

        assert.equal(transcript.firstMessage, 'what does this do?');
    });

    it('reads the first text block of array content', () => {
        const transcript = parseTranscript([
            userLine([{ type: 'text', text: 'array content' }, { type: 'text', text: 'ignored' }]),
        ]);

        assert.equal(transcript.firstMessage, 'array content');
    });

    it('skips <command-name> messages', () => {
        const transcript = parseTranscript([
            userLine('<command-name>/status</command-name>'),
            userLine('the real question'),
        ]);

        assert.equal(transcript.firstMessage, 'the real question');
    });

    it('skips <local-command- messages', () => {
        const transcript = parseTranscript([
            userLine('<local-command-stdout>done</local-command-stdout>'),
            userLine('the real question'),
        ]);

        assert.equal(transcript.firstMessage, 'the real question');
    });

    it('skips Caveat: messages', () => {
        const transcript = parseTranscript([
            userLine('Caveat: The messages below were generated...'),
            userLine('the real question'),
        ]);

        assert.equal(transcript.firstMessage, 'the real question');
    });

    it('skips a message whose command marker is not at the start', () => {
        // The filter is a substring test, not a prefix test: a marker anywhere
        // in the message suppresses it.
        const transcript = parseTranscript([
            userLine('please run <command-name>/status</command-name> for me'),
            userLine('the real question'),
        ]);

        assert.equal(transcript.firstMessage, 'the real question');
    });

    it('does not apply the command filter to array content', () => {
        // Current behaviour: the filter sits on the string branch only, so a
        // command wrapped in array content is displayed verbatim.
        const transcript = parseTranscript([
            userLine([{ type: 'text', text: '<command-name>/status</command-name>' }]),
            userLine('the real question'),
        ]);

        assert.equal(transcript.firstMessage, '<command-name>/status</command-name>');
    });

    it('truncates to 60 characters without an ellipsis', () => {
        // The ellipsis is presentation, not part of the parsed value: the
        // tooltip appends it when rendering.
        const transcript = parseTranscript([userLine('a'.repeat(65))]);

        assert.equal(transcript.firstMessage, 'a'.repeat(60));
    });

    it('leaves a short message untouched', () => {
        const transcript = parseTranscript([userLine('short')]);

        assert.equal(transcript.firstMessage, 'short');
    });

    it('leaves the first message empty when there is none', () => {
        const transcript = parseTranscript([assistantLine({ input_tokens: 1 })]);

        assert.equal(transcript.firstMessage, '');
    });
});

describe('parseTranscript — diagnostics', () => {
    it('reports the total line count, blank lines included', () => {
        const transcript = parseTranscript([userLine('hello'), '', assistantLine({ input_tokens: 1 })]);

        assert.equal(transcript.lineCount, 3);
    });

    it('reports no /clear as index -1', () => {
        const transcript = parseTranscript([userLine('hello'), assistantLine({ input_tokens: 1 })]);

        assert.equal(transcript.clearIndex, -1);
    });

    it('reports the index of the /clear line', () => {
        const transcript = parseTranscript([
            userLine('hello'),
            assistantLine({ input_tokens: 5_000 }),
            CLEAR_LINE,
            userLine('back again'),
        ]);

        assert.equal(transcript.clearIndex, 2);
    });

    it('reports the index of the last /clear when there are several', () => {
        const transcript = parseTranscript([
            userLine('first round'),
            CLEAR_LINE,
            userLine('second round'),
            CLEAR_LINE,
            userLine('third round'),
        ]);

        assert.equal(transcript.clearIndex, 3);
    });

    it('counts corrupt JSON lines as skipped', () => {
        const transcript = parseTranscript([
            '{ this is not json',
            userLine('hello'),
            'half a line',
        ]);

        assert.equal(transcript.skippedLines, 2);
    });

    it('does not count blank lines as skipped', () => {
        const transcript = parseTranscript(['', '   ', '\t', userLine('hello')]);

        assert.equal(transcript.skippedLines, 0);
    });

    it('counts corrupt lines on both sides of the /clear', () => {
        const transcript = parseTranscript([
            'corrupt before',
            CLEAR_LINE,
            'corrupt after',
            userLine('back again'),
        ]);

        assert.equal(transcript.skippedLines, 2);
    });
});

describe('parseTranscript — tolerance', () => {
    it('skips corrupt JSON lines and parses the rest', () => {
        const transcript = parseTranscript([
            '{ this is not json',
            userLine('hello'),
            'half a line',
            assistantLine({ input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 }, 'claude-opus-5'),
            '',
        ]);

        assert.equal(transcript.totalTokens, 60);
        assert.equal(transcript.model, 'claude-opus-5');
        assert.equal(transcript.firstMessage, 'hello');
    });

    it('does not throw on entries whose shape is nothing like a session record', () => {
        const transcript = parseTranscript([
            line(null),
            line(42),
            line('a bare string'),
            line([1, 2, 3]),
            line({ type: 'user', message: { content: { not: 'a string or array' } } }),
            line({ type: 'assistant', message: { usage: 'not an object' } }),
            line({ type: 'assistant', usage: null }),
            line({ timestamp: 12345 }),
        ]);

        assert.equal(transcript.totalTokens, 0);
        assert.equal(transcript.firstMessage, '');
    });

    it('leaves the creation time null when a timestamp is unparseable', () => {
        const transcript = parseTranscript([
            userLine('hello', { timestamp: 'not a date at all' }),
            assistantLine({ input_tokens: 10 }),
        ]);

        // Not an Invalid Date: callers are promised a usable date or null,
        // and Invalid Date throws from `toISOString()`.
        assert.equal(transcript.sessionCreated, null);
    });

    it('falls through a bad timestamp to the next usable one', () => {
        const transcript = parseTranscript([
            userLine('hello', { timestamp: 'not a date at all' }),
            line({ type: 'assistant', timestamp: '2026-07-12T11:00:00.000Z' }),
        ]);

        assert.deepEqual(transcript.sessionCreated, new Date('2026-07-12T11:00:00.000Z'));
    });
});

describe('splitTranscriptLines', () => {
    it('splits content into one line per record', () => {
        assert.deepEqual(splitTranscriptLines('a\nb\nc'), ['a', 'b', 'c']);
    });

    it('drops the terminating newline instead of yielding a phantom line', () => {
        assert.deepEqual(splitTranscriptLines('a\nb\n'), ['a', 'b']);
    });

    it('drops only the last of several terminating newlines', () => {
        assert.deepEqual(splitTranscriptLines('a\n\n'), ['a', '']);
    });

    it('reads empty content as no lines at all', () => {
        assert.deepEqual(splitTranscriptLines(''), []);
    });

    it('keeps blank lines in the middle', () => {
        assert.deepEqual(splitTranscriptLines('a\n\nb'), ['a', '', 'b']);
    });
});
