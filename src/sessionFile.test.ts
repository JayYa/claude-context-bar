import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { decodeProjectPath, getLatestTokenCount } from './sessionFile';

function makeTempJsonl(content: string): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-test-'));
    const filePath = path.join(tmpDir, 'test.jsonl');
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
}

describe('decodeProjectPath', () => {
    describe('Windows paths', () => {
        it('decodes a shallow Windows path (C--dev-webapp)', () => {
            const result = decodeProjectPath('C--dev-webapp');
            assert.equal(result.fullPath, 'C:\\dev\\webapp');
            assert.equal(result.name, 'webapp');
        });

        it('decodes a deep nested Windows path', () => {
            const result = decodeProjectPath('C--dev-tools-extensions-vscode-my-extension');
            assert.equal(result.fullPath, 'C:\\dev\\tools\\extensions\\vscode\\my\\extension');
            assert.equal(result.name, 'vscode-my-extension');
        });

        it('handles Windows path with mixed-case drive letter', () => {
            const result = decodeProjectPath('d--Users-work-project');
            assert.equal(result.fullPath, 'D:\\Users\\work\\project');
            assert.equal(result.name, 'work-project');
        });
    });

    describe('Unix paths', () => {
        it('decodes a shallow Unix path (-Users-name-my-project)', () => {
            const result = decodeProjectPath('-Users-name-my-project');
            assert.equal(result.fullPath, '/Users/name/my/project');
            assert.equal(result.name, 'my-project');
        });

        it('decodes a deep nested Unix path', () => {
            const result = decodeProjectPath('-home-user-work-projects-my-app');
            assert.equal(result.fullPath, '/home/user/work/projects/my/app');
            assert.equal(result.name, 'projects-my-app');
        });
    });

    describe('leading dash stripping', () => {
        it('strips leading dash from a simple path', () => {
            const result = decodeProjectPath('-some-simple-path');
            assert.equal(result.fullPath, '/some/simple/path');
            assert.equal(result.name, 'path');
        });

        it('handles path with no leading dash', () => {
            const result = decodeProjectPath('Users-name-project');
            assert.equal(result.fullPath, '/Users/name/project');
            assert.equal(result.name, 'project');
        });
    });
});

describe('getLatestTokenCount', () => {
    it('returns zero values for an empty file', async () => {
        const filePath = makeTempJsonl('');
        const result = await getLatestTokenCount(filePath);
        assert.equal(result.inputTokens, 0);
        assert.equal(result.cacheReadTokens, 0);
        assert.equal(result.cacheCreationTokens, 0);
        assert.equal(result.totalTokens, 0);
        assert.equal(result.model, '');
        assert.equal(result.firstMessage, '');
        assert.equal(result.sessionCreated, null);
        assert.equal(result.wasCleared, false);
    });

    it('parses usage, model, first message, and sessionCreated from a normal session', async () => {
        const lines = [
            JSON.stringify({ type: 'user', message: { content: 'hello world' }, timestamp: '2025-01-01T00:00:00.000Z' }),
            JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 25 } }, timestamp: '2025-01-01T00:00:01.000Z' }),
        ];
        const filePath = makeTempJsonl(lines.join('\n'));
        const result = await getLatestTokenCount(filePath);
        assert.equal(result.inputTokens, 100);
        assert.equal(result.cacheReadTokens, 50);
        assert.equal(result.cacheCreationTokens, 25);
        assert.equal(result.totalTokens, 175);
        assert.equal(result.model, 'claude-sonnet-4-5');
        assert.equal(result.firstMessage, 'hello world...');
        assert.ok(result.sessionCreated instanceof Date);
        assert.equal(result.sessionCreated?.toISOString(), '2025-01-01T00:00:00.000Z');
        assert.equal(result.wasCleared, false);
    });

    it('detects wasCleared when /clear is the last user activity', async () => {
        const lines = [
            JSON.stringify({ type: 'user', message: { content: 'hello' }, timestamp: '2025-01-01T00:00:00.000Z' }),
            JSON.stringify({ type: 'user', message: { content: '<command-name>/clear</command-name>' }, timestamp: '2025-01-01T00:01:00.000Z' }),
        ];
        const filePath = makeTempJsonl(lines.join('\n'));
        const result = await getLatestTokenCount(filePath);
        assert.equal(result.wasCleared, true);
    });

    it('returns wasCleared=false when there is user activity after /clear', async () => {
        const lines = [
            JSON.stringify({ type: 'user', message: { content: 'hello' }, timestamp: '2025-01-01T00:00:00.000Z' }),
            JSON.stringify({ type: 'user', message: { content: '<command-name>/clear</command-name>' }, timestamp: '2025-01-01T00:01:00.000Z' }),
            JSON.stringify({ type: 'user', message: { content: 'new message after clear' }, timestamp: '2025-01-01T00:02:00.000Z' }),
        ];
        const filePath = makeTempJsonl(lines.join('\n'));
        const result = await getLatestTokenCount(filePath);
        assert.equal(result.wasCleared, false);
        assert.equal(result.firstMessage, 'new message after clear...');
    });

    it('uses the last usage entry when multiple are present', async () => {
        const lines = [
            JSON.stringify({ type: 'user', message: { content: 'hello' }, timestamp: '2025-01-01T00:00:00.000Z' }),
            JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 100, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } }, timestamp: '2025-01-01T00:00:01.000Z' }),
            JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 } }, timestamp: '2025-01-01T00:00:02.000Z' }),
        ];
        const filePath = makeTempJsonl(lines.join('\n'));
        const result = await getLatestTokenCount(filePath);
        assert.equal(result.inputTokens, 500);
        assert.equal(result.cacheReadTokens, 200);
        assert.equal(result.cacheCreationTokens, 50);
        assert.equal(result.totalTokens, 750);
        assert.equal(result.model, 'claude-opus-4-8');
    });

    it('extracts model from entry.message.model', async () => {
        const lines = [
            JSON.stringify({ type: 'user', message: { content: 'hello' }, timestamp: '2025-01-01T00:00:00.000Z' }),
            JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4-5', usage: { input_tokens: 50 } }, timestamp: '2025-01-01T00:00:01.000Z' }),
        ];
        const filePath = makeTempJsonl(lines.join('\n'));
        const result = await getLatestTokenCount(filePath);
        assert.equal(result.model, 'claude-haiku-4-5');
    });

    it('skips command messages and finds the first real user message', async () => {
        const lines = [
            JSON.stringify({ type: 'user', message: { content: '<command-name>/help</command-name>' }, timestamp: '2025-01-01T00:00:00.000Z' }),
            JSON.stringify({ type: 'user', message: { content: '<local-command-echo>test</local-command-echo>' }, timestamp: '2025-01-01T00:00:01.000Z' }),
            JSON.stringify({ type: 'user', message: { content: 'Caveat: something' }, timestamp: '2025-01-01T00:00:02.000Z' }),
            JSON.stringify({ type: 'user', message: { content: 'actual first message' }, timestamp: '2025-01-01T00:00:03.000Z' }),
        ];
        const filePath = makeTempJsonl(lines.join('\n'));
        const result = await getLatestTokenCount(filePath);
        assert.equal(result.firstMessage, 'actual first message...');
    });

    it('extracts sessionCreated from the first timestamp after clear', async () => {
        const lines = [
            JSON.stringify({ type: 'user', message: { content: 'old session' }, timestamp: '2025-01-01T00:00:00.000Z' }),
            JSON.stringify({ type: 'user', message: { content: '<command-name>/clear</command-name>' }, timestamp: '2025-01-01T00:01:00.000Z' }),
            JSON.stringify({ type: 'user', message: { content: 'new session' }, timestamp: '2025-01-02T12:00:00.000Z' }),
        ];
        const filePath = makeTempJsonl(lines.join('\n'));
        const result = await getLatestTokenCount(filePath);
        assert.equal(result.wasCleared, false);
        assert.equal(result.sessionCreated?.toISOString(), '2025-01-02T12:00:00.000Z');
    });

    it('skips malformed JSON lines without crashing', async () => {
        const lines = [
            'this is not json',
            '',
            JSON.stringify({ type: 'user', message: { content: 'hello' }, timestamp: '2025-01-01T00:00:00.000Z' }),
            '{broken json',
            JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 42 } }, timestamp: '2025-01-01T00:00:01.000Z' }),
        ];
        const filePath = makeTempJsonl(lines.join('\n'));
        const result = await getLatestTokenCount(filePath);
        assert.equal(result.inputTokens, 42);
        assert.equal(result.model, 'claude-sonnet-4-5');
        assert.equal(result.firstMessage, 'hello...');
    });

    it('supports usage at the top-level entry.usage field', async () => {
        const lines = [
            JSON.stringify({ type: 'user', message: { content: 'hello' }, timestamp: '2025-01-01T00:00:00.000Z' }),
            JSON.stringify({ type: 'result', usage: { input_tokens: 200, cache_read_input_tokens: 75, cache_creation_input_tokens: 30 }, timestamp: '2025-01-01T00:00:01.000Z' }),
        ];
        const filePath = makeTempJsonl(lines.join('\n'));
        const result = await getLatestTokenCount(filePath);
        assert.equal(result.inputTokens, 200);
        assert.equal(result.cacheReadTokens, 75);
        assert.equal(result.cacheCreationTokens, 30);
        assert.equal(result.totalTokens, 305);
    });

    it('extracts first message from array-format user message content', async () => {
        const lines = [
            JSON.stringify({ type: 'user', message: { content: [{ text: 'hello from array' }] }, timestamp: '2025-01-01T00:00:00.000Z' }),
        ];
        const filePath = makeTempJsonl(lines.join('\n'));
        const result = await getLatestTokenCount(filePath);
        assert.equal(result.firstMessage, 'hello from array...');
    });

    it('uses the injected readFile function instead of fs.readFileSync', async () => {
        // Content that the injected readFile returns (different from file on disk)
        const injectedContent = [
            JSON.stringify({ type: 'user', message: { content: 'injected content' }, timestamp: '2025-01-01T00:00:00.000Z' }),
            JSON.stringify({ type: 'assistant', message: { model: 'injected-model', usage: { input_tokens: 999 } }, timestamp: '2025-01-01T00:00:01.000Z' }),
        ].join('\n');

        // File on disk has different content — if injection fails, assertions catch it
        const realContent = [
            JSON.stringify({ type: 'user', message: { content: 'real file content' }, timestamp: '2025-01-01T00:00:00.000Z' }),
            JSON.stringify({ type: 'assistant', message: { model: 'real-model', usage: { input_tokens: 111 } }, timestamp: '2025-01-01T00:00:01.000Z' }),
        ].join('\n');

        const filePath = makeTempJsonl(realContent);
        let readFileCalled = false;
        const injectedReadFile = (p: string) => {
            readFileCalled = true;
            return injectedContent;
        };

        const result = await getLatestTokenCount(filePath, injectedReadFile);
        assert.ok(readFileCalled);
        // Should reflect injected content, not the file's real content
        assert.equal(result.inputTokens, 999);
        assert.equal(result.model, 'injected-model');
        assert.equal(result.firstMessage, 'injected content...');
    });
});
