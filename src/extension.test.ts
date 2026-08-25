import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// `extension.ts` imports `vscode`, which only exists inside the extension
// host. Nothing in the module touches vscode at load time, so a bare stub is
// enough to require it from a plain node test. This stub, and the temp-file
// plumbing below, exist only because the parser's current interface is a path
// on disk; both go away when that interface does.
const nodeModule = require('node:module');
const originalResolveFilename = nodeModule._resolveFilename;
nodeModule._resolveFilename = function (request: string, ...rest: unknown[]) {
    return request === 'vscode' ? 'vscode' : originalResolveFilename.call(this, request, ...rest);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: {} } as any;

const { getLatestTokenCount } = require('./extension') as typeof import('./extension');

// --- fixtures ---------------------------------------------------------------
//
// Fixtures are written as an array of JSONL lines: that is the shape the
// parser will eventually take directly. `line()` keeps them readable; a
// fixture may also hold a hand-written string, e.g. a corrupt line.

function line(entry: unknown): string {
    return JSON.stringify(entry);
}

function userLine(content: unknown, extra: Record<string, unknown> = {}): string {
    return line({ type: 'user', message: { content }, ...extra });
}

function assistantLine(usage: Record<string, number>, model?: string): string {
    const message: Record<string, unknown> = { usage };
    if (model) {
        message.model = model;
    }
    return line({ type: 'assistant', message });
}

const CLEAR_LINE = userLine('<command-name>/clear</command-name>');

const tempDirs: string[] = [];

after(() => {
    for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// Writes a line-array fixture to a JSONL file in a fresh temp dir and returns
// its path. Every directory created here is removed when the suite ends.
function writeSession(lines: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-session-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, lines.join('\n'), 'utf-8');
    return file;
}

// --- tests ------------------------------------------------------------------

describe('getLatestTokenCount: basic parsing', () => {
    it('reports an empty session as all zeros', async () => {
        const usage = await getLatestTokenCount(writeSession([]));

        assert.equal(usage.inputTokens, 0);
        assert.equal(usage.cacheReadTokens, 0);
        assert.equal(usage.cacheCreationTokens, 0);
        assert.equal(usage.totalTokens, 0);
        assert.equal(usage.model, '');
        assert.equal(usage.firstMessage, '');
        assert.equal(usage.sessionCreated, null);
        assert.equal(usage.wasCleared, false);
    });

    it('reports a blank-lines-only session as all zeros', async () => {
        const usage = await getLatestTokenCount(writeSession(['', '   ', '\t', '']));

        assert.equal(usage.totalTokens, 0);
        assert.equal(usage.model, '');
        assert.equal(usage.firstMessage, '');
        assert.equal(usage.sessionCreated, null);
        assert.equal(usage.wasCleared, false);
    });

    it('takes the last usage record when several are present', async () => {
        const usage = await getLatestTokenCount(writeSession([
            assistantLine({ input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 }),
            assistantLine({ input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 }),
        ]));

        assert.equal(usage.inputTokens, 1);
        assert.equal(usage.cacheReadTokens, 2);
        assert.equal(usage.cacheCreationTokens, 3);
    });

    it('totals input, cache read and cache creation tokens', async () => {
        const usage = await getLatestTokenCount(writeSession([
            assistantLine({ input_tokens: 100, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 30_000 }),
        ]));

        assert.equal(usage.totalTokens, 32_100);
    });

    it('treats missing usage fields as zero', async () => {
        const usage = await getLatestTokenCount(writeSession([
            assistantLine({ input_tokens: 100 }),
        ]));

        assert.equal(usage.cacheReadTokens, 0);
        assert.equal(usage.cacheCreationTokens, 0);
        assert.equal(usage.totalTokens, 100);
    });

    it('takes the last model id seen', async () => {
        const usage = await getLatestTokenCount(writeSession([
            assistantLine({ input_tokens: 1 }, 'claude-sonnet-5'),
            assistantLine({ input_tokens: 2 }, 'claude-opus-5'),
        ]));

        assert.equal(usage.model, 'claude-opus-5');
    });

    it('reads usage from a top-level `usage` field', async () => {
        const usage = await getLatestTokenCount(writeSession([
            line({ type: 'assistant', usage: { input_tokens: 7, cache_read_input_tokens: 8, cache_creation_input_tokens: 9 } }),
        ]));

        assert.equal(usage.totalTokens, 24);
    });

    it('reads usage from a nested `message.usage` field', async () => {
        const usage = await getLatestTokenCount(writeSession([
            line({ type: 'assistant', message: { usage: { input_tokens: 7, cache_read_input_tokens: 8, cache_creation_input_tokens: 9 } } }),
        ]));

        assert.equal(usage.totalTokens, 24);
    });

    it('prefers `message.usage` over a top-level `usage` on the same entry', async () => {
        const usage = await getLatestTokenCount(writeSession([
            line({
                type: 'assistant',
                usage: { input_tokens: 1 },
                message: { usage: { input_tokens: 500 } },
            }),
        ]));

        assert.equal(usage.inputTokens, 500);
    });

    it('takes the session creation time from the first timestamped entry', async () => {
        const usage = await getLatestTokenCount(writeSession([
            userLine('hello', { timestamp: '2026-07-12T10:00:00.000Z' }),
            assistantLine({ input_tokens: 1 }),
            line({ type: 'assistant', timestamp: '2026-07-12T11:00:00.000Z' }),
        ]));

        assert.deepEqual(usage.sessionCreated, new Date('2026-07-12T10:00:00.000Z'));
    });
});

describe('getLatestTokenCount: /clear semantics', () => {
    it('is cleared when no user message follows the /clear', async () => {
        const usage = await getLatestTokenCount(writeSession([
            userLine('hello'),
            assistantLine({ input_tokens: 5_000 }),
            CLEAR_LINE,
        ]));

        assert.equal(usage.wasCleared, true);
    });

    it('is not cleared when a user message follows the /clear', async () => {
        const usage = await getLatestTokenCount(writeSession([
            userLine('hello'),
            assistantLine({ input_tokens: 5_000 }),
            CLEAR_LINE,
            userLine('back again'),
        ]));

        assert.equal(usage.wasCleared, false);
    });

    it('counts only what comes after the /clear', async () => {
        const usage = await getLatestTokenCount(writeSession([
            userLine('before the clear'),
            assistantLine({ input_tokens: 5_000 }, 'claude-sonnet-5'),
            CLEAR_LINE,
            userLine('after the clear'),
            assistantLine({ input_tokens: 42 }, 'claude-opus-5'),
        ]));

        assert.equal(usage.inputTokens, 42);
        assert.equal(usage.totalTokens, 42);
        assert.equal(usage.model, 'claude-opus-5');
        assert.equal(usage.firstMessage, 'after the clear...');
    });

    it('a session with no /clear counts from the top', async () => {
        const usage = await getLatestTokenCount(writeSession([
            userLine('hello'),
            assistantLine({ input_tokens: 5_000 }),
        ]));

        assert.equal(usage.wasCleared, false);
        assert.equal(usage.totalTokens, 5_000);
        assert.equal(usage.firstMessage, 'hello...');
    });

    it('the last /clear wins when there are several', async () => {
        const usage = await getLatestTokenCount(writeSession([
            userLine('first round'),
            CLEAR_LINE,
            userLine('second round'),
            assistantLine({ input_tokens: 5_000 }),
            CLEAR_LINE,
            userLine('third round'),
            assistantLine({ input_tokens: 42 }),
        ]));

        assert.equal(usage.wasCleared, false);
        assert.equal(usage.totalTokens, 42);
        assert.equal(usage.firstMessage, 'third round...');
    });
});

describe('getLatestTokenCount: first message', () => {
    it('reads string content', async () => {
        const usage = await getLatestTokenCount(writeSession([userLine('what does this do?')]));

        assert.equal(usage.firstMessage, 'what does this do?...');
    });

    it('reads the first text block of array content', async () => {
        const usage = await getLatestTokenCount(writeSession([
            userLine([{ type: 'text', text: 'array content' }, { type: 'text', text: 'ignored' }]),
        ]));

        assert.equal(usage.firstMessage, 'array content...');
    });

    it('skips <command-name> messages', async () => {
        const usage = await getLatestTokenCount(writeSession([
            userLine('<command-name>/status</command-name>'),
            userLine('the real question'),
        ]));

        assert.equal(usage.firstMessage, 'the real question...');
    });

    it('skips <local-command- messages', async () => {
        const usage = await getLatestTokenCount(writeSession([
            userLine('<local-command-stdout>done</local-command-stdout>'),
            userLine('the real question'),
        ]));

        assert.equal(usage.firstMessage, 'the real question...');
    });

    it('skips Caveat: messages', async () => {
        const usage = await getLatestTokenCount(writeSession([
            userLine('Caveat: The messages below were generated...'),
            userLine('the real question'),
        ]));

        assert.equal(usage.firstMessage, 'the real question...');
    });

    it('does not apply the command filter to array content', async () => {
        // Current behaviour: the filter sits on the string branch only, so a
        // command wrapped in array content is displayed verbatim.
        const usage = await getLatestTokenCount(writeSession([
            userLine([{ type: 'text', text: '<command-name>/status</command-name>' }]),
            userLine('the real question'),
        ]));

        assert.equal(usage.firstMessage, '<command-name>/status</command-name>...');
    });

    it('truncates to 60 characters and appends an ellipsis', async () => {
        const usage = await getLatestTokenCount(writeSession([userLine('a'.repeat(65))]));

        assert.equal(usage.firstMessage, 'a'.repeat(60) + '...');
    });

    it('appends the ellipsis even when nothing was truncated', async () => {
        // Current behaviour: the ellipsis is unconditional, so a short message
        // reads as if it had been cut off.
        const usage = await getLatestTokenCount(writeSession([userLine('short')]));

        assert.equal(usage.firstMessage, 'short...');
    });

    it('leaves the first message empty when there is none', async () => {
        const usage = await getLatestTokenCount(writeSession([assistantLine({ input_tokens: 1 })]));

        assert.equal(usage.firstMessage, '');
    });
});

describe('getLatestTokenCount: tolerance', () => {
    it('skips corrupt JSON lines and parses the rest', async () => {
        const usage = await getLatestTokenCount(writeSession([
            '{ this is not json',
            userLine('hello'),
            'half a line',
            assistantLine({ input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 }, 'claude-opus-5'),
            '',
        ]));

        assert.equal(usage.totalTokens, 60);
        assert.equal(usage.model, 'claude-opus-5');
        assert.equal(usage.firstMessage, 'hello...');
    });

    it('returns all zeros when the file does not exist', async () => {
        const usage = await getLatestTokenCount(path.join(os.tmpdir(), 'ccb-does-not-exist.jsonl'));

        assert.equal(usage.totalTokens, 0);
        assert.equal(usage.model, '');
        assert.equal(usage.firstMessage, '');
        assert.equal(usage.sessionCreated, null);
        assert.equal(usage.wasCleared, false);
    });
});
