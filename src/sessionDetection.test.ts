import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    detectSessions,
    _test,
    SessionInfo,
    DetectionOptions,
} from './sessionDetection';
const { processSessionGroups } = _test;

// ============================================================================
// TEST HELPERS
// ============================================================================

interface TempFileDef {
    /** Filename (e.g. "abc12345.jsonl") */
    name: string;
    /** JSONL lines to write */
    lines: string[];
    /** mtime offset in seconds before now (default 0 = "just now") */
    mtimeOffsetSec?: number;
}

interface TempProject {
    rootDir: string;
    /** Full cleanup: removes the temp directory recursively */
    cleanup: () => void;
}

const defaultOptions: DetectionOptions = {
    idleTimeout: 180,
    contextLimit: 200_000,
    modelContextLimits: {},
};

/**
 * Create a temporary Claude-projects directory with project subdirectories
 * and JSONL session files. Returns the root dir path and a cleanup function.
 *
 * Usage:
 *   const { rootDir, cleanup } = makeTempProjectsDir({
 *       'C--dev-myproject': [
 *           { name: 'abc.jsonl', lines: [...], mtimeOffsetSec: 0 },
 *       ],
 *   });
 *   try { ... detectSessions(rootDir, opts) ... } finally { cleanup(); }
 */
function makeTempProjectsDir(
    projects: Record<string, TempFileDef[]>,
): TempProject {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-detect-'));
    const now = Date.now();

    for (const [projectDir, files] of Object.entries(projects)) {
        const projectPath = path.join(rootDir, projectDir);
        fs.mkdirSync(projectPath, { recursive: true });

        for (const file of files) {
            const filePath = path.join(projectPath, file.name);
            const content = file.lines.join('\n');
            fs.writeFileSync(filePath, content, 'utf-8');

            // Set mtime to simulate file age
            const offsetMs = (file.mtimeOffsetSec || 0) * 1000;
            const mtime = new Date(now - offsetMs);
            fs.utimesSync(filePath, mtime, mtime);
        }
    }

    return {
        rootDir,
        cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }),
    };
}

// ============================================================================
// SYNTHETIC SessionInfo BUILDERS
// ============================================================================

/**
 * Minimal SessionInfo factory for testing processSessionGroups.
 * Defaults represent a valid, non-cleared, active session.
 */
function makeSession(overrides: Partial<SessionInfo> & { projectName: string }): SessionInfo {
    const now = new Date();
    return {
        projectName: overrides.projectName,
        projectPath: `/fake/${overrides.projectName}`,
        sessionId: overrides.sessionId || 'abc12345',
        sessionFile: overrides.sessionFile || `/fake/${overrides.projectName}/abc12345.jsonl`,
        inputTokens: 100,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 100,
        percentage: 50,
        lastUpdated: overrides.lastUpdated || now,
        model: 'claude-sonnet-5',
        contextLimit: 200_000,
        firstMessage: 'hello...',
        sessionCreated: overrides.sessionCreated !== undefined ? overrides.sessionCreated : now,
        wasCleared: overrides.wasCleared || false,
    };
}

// ============================================================================
// processSessionGroups  UNIT TESTS
// ============================================================================

describe('processSessionGroups', () => {
    it('returns empty array for empty input', () => {
        assert.deepEqual(processSessionGroups([]), []);
    });

    it('returns single session unchanged (no suffix)', () => {
        const s = makeSession({ projectName: 'myproject' });
        const result = processSessionGroups([s]);
        assert.equal(result.length, 1);
        assert.equal(result[0].projectName, 'myproject');
    });

    it('filters out cleared sessions', () => {
        const active = makeSession({
            projectName: 'proj',
            sessionId: 'active001',
            sessionCreated: new Date('2025-06-01'),
        });
        const cleared = makeSession({
            projectName: 'proj',
            sessionId: 'cleared01',
            sessionCreated: new Date('2025-07-01'),
            wasCleared: true,
        });
        const result = processSessionGroups([active, cleared]);
        assert.equal(result.length, 1);
        assert.equal(result[0].sessionId, 'active001');
    });

    it('filters out superseded sessions (newer session created after older lastUpdated)', () => {
        const t1 = new Date('2025-06-01T10:00:00Z'); // old session created
        const t2 = new Date('2025-06-01T11:00:00Z'); // old session last updated
        const t3 = new Date('2025-06-02T10:00:00Z'); // NEW session created AFTER old's last update

        const oldSession = makeSession({
            projectName: 'proj',
            sessionId: 'old00001',
            sessionCreated: t1,
            lastUpdated: t2,
        });
        const newSession = makeSession({
            projectName: 'proj',
            sessionId: 'new00001',
            sessionCreated: t3,
            lastUpdated: t3,
        });

        // Sorting by mtime desc puts newSession first (it's more recent)
        const result = processSessionGroups([newSession, oldSession]);
        assert.equal(result.length, 1);
        assert.equal(result[0].sessionId, 'new00001');
    });

    it('keeps non-superseded sessions (newer created BEFORE older lastUpdated)', () => {
        const t1 = new Date('2025-06-01T10:00:00Z'); // session A created
        const t2 = new Date('2025-06-01T12:00:00Z'); // session A last updated
        const t3 = new Date('2025-06-01T11:00:00Z'); // session B created (BETWEEN A's create and A's last update)

        // A was updated AFTER B was created, so A is still active (not superseded)
        const sessionA = makeSession({
            projectName: 'proj',
            sessionId: 'sessA001',
            sessionCreated: t1,
            lastUpdated: t2,
        });
        const sessionB = makeSession({
            projectName: 'proj',
            sessionId: 'sessB001',
            sessionCreated: t3,
            lastUpdated: t3,
        });

        // B is newest created, but was created before A's last update
        // Both should be kept
        const result = processSessionGroups([sessionB, sessionA]);
        assert.equal(result.length, 2);
    });

    it('applies stable numbering: oldest active keeps bare name, rest get -2, -3', () => {
        const t1 = new Date('2025-01-01T10:00:00Z'); // oldest created
        const t2 = new Date('2025-01-02T10:00:00Z'); // middle created
        const t3 = new Date('2025-01-03T10:00:00Z'); // newest created
        const tUpd = new Date('2025-02-01T10:00:00Z'); // all updated after all creates

        // All sessions have lastUpdated AFTER the newest sessionCreated,
        // so none are superseded. But lastUpdated differs for sort order.
        const s1 = makeSession({ projectName: 'proj', sessionId: 's1', sessionCreated: t1, lastUpdated: new Date('2025-02-01T10:00:01Z') });
        const s2 = makeSession({ projectName: 'proj', sessionId: 's2', sessionCreated: t2, lastUpdated: new Date('2025-02-01T10:00:02Z') });
        const s3 = makeSession({ projectName: 'proj', sessionId: 's3', sessionCreated: t3, lastUpdated: new Date('2025-02-01T10:00:03Z') });

        const result = processSessionGroups([s3, s2, s1]);

        // 3 sessions all active — sorted by lastUpdated desc
        assert.equal(result.length, 3);
        // s3 has newest lastUpdated → first
        assert.equal(result[0].sessionId, 's3');
        assert.equal(result[0].projectName, 'proj-3');
        assert.equal(result[1].sessionId, 's2');
        assert.equal(result[1].projectName, 'proj-2');
        assert.equal(result[2].sessionId, 's1');
        assert.equal(result[2].projectName, 'proj');
    });

    it('numbers multiple projects independently', () => {
        const t1 = new Date('2025-01-01T10:00:00Z');
        const t2 = new Date('2025-01-02T10:00:00Z');
        // Both alpha sessions updated after the newer one was created → neither superseded
        const tUpd = new Date('2025-02-01T10:00:00Z');

        const projA1 = makeSession({ projectName: 'alpha', sessionId: 'a1', sessionCreated: t1, lastUpdated: new Date('2025-02-01T10:00:01Z') });
        const projA2 = makeSession({ projectName: 'alpha', sessionId: 'a2', sessionCreated: t2, lastUpdated: new Date('2025-02-01T10:00:02Z') });
        const projB1 = makeSession({ projectName: 'beta', sessionId: 'b1', sessionCreated: t1, lastUpdated: new Date('2025-02-01T10:00:03Z') });

        const result = processSessionGroups([projB1, projA2, projA1]);

        // beta has 1 session → "beta"
        // alpha has 2 → sorted by creation ascending → a1 (bare), a2 (-2)
        // Final sort by lastUpdated desc → b1 first (newest lastUpdated), then a2, then a1
        assert.equal(result.length, 3);
        assert.equal(result[0].sessionId, 'b1');
        assert.equal(result[0].projectName, 'beta');
        assert.equal(result[1].sessionId, 'a2');
        assert.equal(result[1].projectName, 'alpha-2');
        assert.equal(result[2].sessionId, 'a1');
        assert.equal(result[2].projectName, 'alpha');
    });

    it('handles session with null sessionCreated', () => {
        const t1 = new Date('2025-06-01T10:00:00Z');
        const normal = makeSession({
            projectName: 'proj',
            sessionId: 'normal01',
            sessionCreated: t1,
            lastUpdated: t1,
        });
        const noCreated = makeSession({
            projectName: 'proj',
            sessionId: 'nocreated',
            sessionCreated: null,
            lastUpdated: new Date('2025-06-02T10:00:00Z'),
        });

        // null sessionCreated → getTime() = 0, so it sorts as "oldest" when
        // sorting by creation ascending for stable numbering.
        // Supersession check: normal.created (t1) > noCreated.lastUpdated (t2)?
        // t1 < t2 → no, not superseded. Both survive.
        const result = processSessionGroups([normal, noCreated]);
        assert.equal(result.length, 2);
        // Sorted by lastUpdated desc: noCreated (newer) first, normal second
        assert.equal(result[0].sessionId, 'nocreated');
        // noCreated has null creation → treated as oldest → gets bare name "proj"
        assert.equal(result[0].projectName, 'proj');
        assert.equal(result[1].sessionId, 'normal01');
        // normal01 has later creation → gets suffix
        assert.equal(result[1].projectName, 'proj-2');
    });

    it('sorts final result by lastUpdated descending', () => {
        const t1 = new Date('2025-01-01T10:00:00Z');
        const t2 = new Date('2025-01-02T10:00:00Z');
        const t3 = new Date('2025-01-03T10:00:00Z');

        const s1 = makeSession({ projectName: 'x', sessionId: 'x1', sessionCreated: t1, lastUpdated: t1 });
        const s2 = makeSession({ projectName: 'y', sessionId: 'y1', sessionCreated: t2, lastUpdated: t2 });
        const s3 = makeSession({ projectName: 'z', sessionId: 'z1', sessionCreated: t3, lastUpdated: t3 });

        const result = processSessionGroups([s1, s3, s2]); // input order shouldn't matter
        assert.equal(result.length, 3);
        assert.equal(result[0].sessionId, 'z1');
        assert.equal(result[1].sessionId, 'y1');
        assert.equal(result[2].sessionId, 'x1');
    });
});

// ============================================================================
// detectSessions  INTEGRATION TESTS
// ============================================================================

describe('detectSessions', () => {
    it('returns empty array for empty directory', async () => {
        const { rootDir, cleanup } = makeTempProjectsDir({});
        try {
            const result = await detectSessions(rootDir, defaultOptions);
            assert.deepEqual(result, []);
        } finally {
            cleanup();
        }
    });

    it('returns empty array when directory does not exist', async () => {
        const result = await detectSessions('/nonexistent/path/12345', defaultOptions);
        assert.deepEqual(result, []);
    });

    it('skips non-directory entries in the projects dir', async () => {
        const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-detect-'));
        try {
            // Create a file (not directory) directly in rootDir
            fs.writeFileSync(path.join(rootDir, 'somefile.txt'), 'hello', 'utf-8');
            const result = await detectSessions(rootDir, defaultOptions);
            assert.deepEqual(result, []);
        } finally {
            fs.rmSync(rootDir, { recursive: true, force: true });
        }
    });

    it('skips claude-plugins and claude-mem directories', async () => {
        const { rootDir, cleanup } = makeTempProjectsDir({
            'claude-plugins-someplugin': [
                {
                    name: 'abc12345.jsonl',
                    lines: [
                        JSON.stringify({ type: 'user', message: { content: 'hi' }, timestamp: '2025-07-01T10:00:00.000Z' }),
                        JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 100 } }, timestamp: '2025-07-01T10:00:01.000Z' }),
                    ],
                },
            ],
            'claude-mem-something': [
                {
                    name: 'def67890.jsonl',
                    lines: [
                        JSON.stringify({ type: 'user', message: { content: 'hi' }, timestamp: '2025-07-01T10:00:00.000Z' }),
                        JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 100 } }, timestamp: '2025-07-01T10:00:01.000Z' }),
                    ],
                },
            ],
        });
        try {
            const result = await detectSessions(rootDir, defaultOptions);
            assert.deepEqual(result, []);
        } finally {
            cleanup();
        }
    });

    it('skips agent-* JSONL files', async () => {
        const { rootDir, cleanup } = makeTempProjectsDir({
            'C--dev-myproject': [
                {
                    name: 'agent-abcde.jsonl',
                    lines: [
                        JSON.stringify({ type: 'user', message: { content: 'hi' }, timestamp: '2025-07-01T10:00:00.000Z' }),
                        JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 100 } }, timestamp: '2025-07-01T10:00:01.000Z' }),
                    ],
                },
            ],
        });
        try {
            const result = await detectSessions(rootDir, defaultOptions);
            assert.deepEqual(result, []);
        } finally {
            cleanup();
        }
    });

    it('detects single active session with correct token, model, and project name', async () => {
        const { rootDir, cleanup } = makeTempProjectsDir({
            'C--dev-my-cool-project': [
                {
                    name: 'abc12345.jsonl',
                    lines: [
                        JSON.stringify({ type: 'user', message: { content: 'build a rest api' }, timestamp: '2025-07-15T10:00:00.000Z' }),
                        JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 100 } }, timestamp: '2025-07-15T10:00:01.000Z' }),
                    ],
                },
            ],
        });
        try {
            const result = await detectSessions(rootDir, defaultOptions);

            assert.equal(result.length, 1);
            const s = result[0];

            // 15 field checks
            assert.equal(s.projectName, 'my-cool-project');
            assert.equal(s.projectPath, 'C:\\dev\\my\\cool\\project');
            assert.equal(s.sessionId, 'abc12345');
            assert.ok(s.sessionFile.endsWith('abc12345.jsonl'));
            assert.equal(s.inputTokens, 500);
            assert.equal(s.cacheReadTokens, 200);
            assert.equal(s.cacheCreationTokens, 100);
            assert.equal(s.totalTokens, 800);
            // percentage = 800/1000000 * 100 = 0% (rounded)
            assert.equal(s.percentage, 0);
            assert.ok(s.lastUpdated instanceof Date);
            assert.equal(s.model, 'claude-opus-4-8');
            // claude-opus-4-8 → 1M by default
            assert.equal(s.contextLimit, 1_000_000);
            assert.equal(s.firstMessage, 'build a rest api...');
            assert.ok(s.sessionCreated instanceof Date);
            assert.equal(s.sessionCreated?.toISOString(), '2025-07-15T10:00:00.000Z');
            assert.equal(s.wasCleared, false);
        } finally {
            cleanup();
        }
    });

    it('reads token percentage correctly for a 200K model (Haiku)', async () => {
        const { rootDir, cleanup } = makeTempProjectsDir({
            'C--dev-haikutest': [
                {
                    name: 'haiku001.jsonl',
                    lines: [
                        JSON.stringify({ type: 'user', message: { content: 'hello' }, timestamp: '2025-07-15T10:00:00.000Z' }),
                        JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4-5', usage: { input_tokens: 100_000 } }, timestamp: '2025-07-15T10:00:01.000Z' }),
                    ],
                },
            ],
        });
        try {
            const result = await detectSessions(rootDir, defaultOptions);
            assert.equal(result.length, 1);
            assert.equal(result[0].model, 'claude-haiku-4-5');
            assert.equal(result[0].contextLimit, 200_000);
            assert.equal(result[0].percentage, 50); // 100K / 200K = 50%
        } finally {
            cleanup();
        }
    });

    it('uses modelContextLimits override for context limit detection', async () => {
        const { rootDir, cleanup } = makeTempProjectsDir({
            'C--dev-override': [
                {
                    name: 'override1.jsonl',
                    lines: [
                        JSON.stringify({ type: 'user', message: { content: 'hello' }, timestamp: '2025-07-15T10:00:00.000Z' }),
                        JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 250_000 } }, timestamp: '2025-07-15T10:00:01.000Z' }),
                    ],
                },
            ],
        });
        try {
            const options: DetectionOptions = {
                ...defaultOptions,
                modelContextLimits: { 'claude-opus-4-8': 500_000 },
            };
            const result = await detectSessions(rootDir, options);
            assert.equal(result.length, 1);
            assert.equal(result[0].contextLimit, 500_000);
            assert.equal(result[0].percentage, 50); // 250K / 500K = 50%
        } finally {
            cleanup();
        }
    });

    it('filters out cleared sessions', async () => {
        const { rootDir, cleanup } = makeTempProjectsDir({
            'C--dev-proj': [
                {
                    name: 'cleared01.jsonl',
                    lines: [
                        JSON.stringify({ type: 'user', message: { content: 'hello' }, timestamp: '2025-07-15T10:00:00.000Z' }),
                        JSON.stringify({ type: 'user', message: { content: '<command-name>/clear</command-name>' }, timestamp: '2025-07-15T10:01:00.000Z' }),
                    ],
                },
            ],
        });
        try {
            const result = await detectSessions(rootDir, defaultOptions);
            assert.deepEqual(result, []);
        } finally {
            cleanup();
        }
    });

    it('filters out sessions with totalTokens === 0', async () => {
        const { rootDir, cleanup } = makeTempProjectsDir({
            'C--dev-proj': [
                {
                    name: 'empty001.jsonl',
                    lines: [''], // empty line, no token data
                },
            ],
        });
        try {
            const result = await detectSessions(rootDir, defaultOptions);
            assert.deepEqual(result, []);
        } finally {
            cleanup();
        }
    });

    it('filters out sessions exceeding idle timeout', async () => {
        const { rootDir, cleanup } = makeTempProjectsDir({
            'C--dev-proj': [
                {
                    name: 'stale001.jsonl',
                    lines: [
                        JSON.stringify({ type: 'user', message: { content: 'hello' }, timestamp: '2025-07-15T10:00:00.000Z' }),
                        JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 100 } }, timestamp: '2025-07-15T10:00:01.000Z' }),
                    ],
                    // Set mtime 200 seconds ago (exceeds 180s default)
                    mtimeOffsetSec: 200,
                },
            ],
        });
        try {
            const result = await detectSessions(rootDir, defaultOptions);
            assert.deepEqual(result, []);
        } finally {
            cleanup();
        }
    });

    it('keeps sessions within idle timeout', async () => {
        const { rootDir, cleanup } = makeTempProjectsDir({
            'C--dev-proj': [
                {
                    name: 'fresh001.jsonl',
                    lines: [
                        JSON.stringify({ type: 'user', message: { content: 'hello' }, timestamp: '2025-07-15T10:00:00.000Z' }),
                        JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 100 } }, timestamp: '2025-07-15T10:00:01.000Z' }),
                    ],
                    // mtimeOffsetSec defaults to 0 = "just now" = within timeout
                },
            ],
        });
        try {
            const result = await detectSessions(rootDir, defaultOptions);
            assert.equal(result.length, 1);
        } finally {
            cleanup();
        }
    });

    it('filters superseded sessions within same project', async () => {
        // Simulate: old session last updated 120s ago, new session created 60s ago.
        // New session's sessionCreated (60s ago) > old session's lastUpdated (120s ago)
        // → old session is superseded.
        // Both mtimes must be within idleTimeout (180s default).
        const now = Date.now();
        const oldLastUpdated = new Date(now - 120 * 1000).toISOString();
        const oldCreated = new Date(now - 300 * 1000).toISOString();
        const newTime = new Date(now - 40 * 1000).toISOString();

        const { rootDir, cleanup } = makeTempProjectsDir({
            'C--dev-supersede': [
                {
                    name: 'old00123.jsonl',
                    lines: [
                        JSON.stringify({ type: 'user', message: { content: 'old work' }, timestamp: oldCreated }),
                        JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 100 } }, timestamp: oldLastUpdated }),
                    ],
                    mtimeOffsetSec: 120, // lastUpdated = now - 120s
                },
                {
                    name: 'new00456.jsonl',
                    lines: [
                        JSON.stringify({ type: 'user', message: { content: 'new work' }, timestamp: newTime }),
                        JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 200 } }, timestamp: newTime }),
                    ],
                    mtimeOffsetSec: 40, // lastUpdated = now - 40s
                },
            ],
        });
        try {
            const result = await detectSessions(rootDir, defaultOptions);
            // new sessionCreated (now-40s) > old lastUpdated (now-120s) → old superseded
            assert.equal(result.length, 1);
            assert.equal(result[0].sessionId, 'new00456');
            assert.equal(result[0].firstMessage, 'new work...');
        } finally {
            cleanup();
        }
    });

    it('applies stable numbering for same project with multiple active sessions', async () => {
        // Two sessions that don't supersede each other (both actively used in parallel)
        // Session A: created Jul 15, lastUpdated Jul 16 (updated after B was created)
        // Session B: created Jul 15 (later time), lastUpdated Jul 15
        // Neither supersedes the other because A was updated AFTER B was created.
        const { rootDir, cleanup } = makeTempProjectsDir({
            'C--dev-multisess': [
                {
                    name: 'sessionA.jsonl',
                    lines: [
                        JSON.stringify({ type: 'user', message: { content: 'task alpha' }, timestamp: '2025-07-15T09:00:00.000Z' }),
                        JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 100 } }, timestamp: '2025-07-16T10:00:00.000Z' }),
                    ],
                },
                {
                    name: 'sessionB.jsonl',
                    lines: [
                        JSON.stringify({ type: 'user', message: { content: 'task beta' }, timestamp: '2025-07-15T10:00:00.000Z' }),
                        JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 200 } }, timestamp: '2025-07-15T10:00:01.000Z' }),
                    ],
                },
            ],
        });
        try {
            const result = await detectSessions(rootDir, defaultOptions);
            assert.equal(result.length, 2);

            // sessionA: created 09:00 (oldest) → bare name "multisess"
            // sessionB: created 10:00 (newer) → "multisess-2"
            // Sort by lastUpdated desc: A (Jul 16) first, B (Jul 15) second
            assert.equal(result[0].sessionId, 'sessionA');
            assert.equal(result[0].projectName, 'multisess');
            assert.equal(result[1].sessionId, 'sessionB');
            assert.equal(result[1].projectName, 'multisess-2');
        } finally {
            cleanup();
        }
    });

    it('numbers multiple projects independently with mixed session counts', async () => {
        const { rootDir, cleanup } = makeTempProjectsDir({
            'C--dev-alpha': [
                {
                    name: 'alpha01.jsonl',
                    lines: [
                        JSON.stringify({ type: 'user', message: { content: 'alpha work' }, timestamp: '2025-07-15T10:00:00.000Z' }),
                        JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 100 } }, timestamp: '2025-07-15T10:00:01.000Z' }),
                    ],
                },
            ],
            'C--dev-beta': [
                {
                    name: 'beta01.jsonl',
                    lines: [
                        JSON.stringify({ type: 'user', message: { content: 'beta older' }, timestamp: '2025-07-14T10:00:00.000Z' }),
                        JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 100 } }, timestamp: '2025-07-16T10:00:01.000Z' }),
                    ],
                },
                {
                    name: 'beta02.jsonl',
                    lines: [
                        JSON.stringify({ type: 'user', message: { content: 'beta newer' }, timestamp: '2025-07-15T10:00:00.000Z' }),
                        JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 200 } }, timestamp: '2025-07-16T10:00:01.000Z' }),
                    ],
                },
            ],
        });
        try {
            const result = await detectSessions(rootDir, defaultOptions);
            // beta has 2 active sessions, alpha has 1
            assert.equal(result.length, 3);

            // Sort by lastUpdated desc
            // All beta sessions have same lastUpdated (Jul 16) via mtime...
            // Actually mtime is "now" for all (mtimeOffsetSec=0).
            // The sort within detectSessions:
            //   files.sort by mtime desc → all have same mtime
            //   Then processSessionGroups sorts within project by creation asc
            //   Then final sort by lastUpdated desc

            // beta sessions appear together, alpha separate
            const projectNames = result.map(s => s.projectName).sort();
            assert.ok(projectNames.includes('alpha'));
            assert.ok(projectNames.includes('beta'));
            assert.ok(projectNames.includes('beta-2'));
        } finally {
            cleanup();
        }
    });

    it('returns results sorted by lastUpdated descending', async () => {
        // Create sessions with different mtimes to test sort order
        const { rootDir, cleanup } = makeTempProjectsDir({
            'C--dev-first': [
                {
                    name: 'first001.jsonl',
                    lines: [
                        JSON.stringify({ type: 'user', message: { content: 'oldest' }, timestamp: '2025-07-14T10:00:00.000Z' }),
                        JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 100 } }, timestamp: '2025-07-14T10:00:01.000Z' }),
                    ],
                    mtimeOffsetSec: 120,
                },
            ],
            'C--dev-second': [
                {
                    name: 'secon001.jsonl',
                    lines: [
                        JSON.stringify({ type: 'user', message: { content: 'middle' }, timestamp: '2025-07-15T10:00:00.000Z' }),
                        JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 100 } }, timestamp: '2025-07-15T10:00:01.000Z' }),
                    ],
                    mtimeOffsetSec: 60,
                },
            ],
            'C--dev-third': [
                {
                    name: 'third001.jsonl',
                    lines: [
                        JSON.stringify({ type: 'user', message: { content: 'newest' }, timestamp: '2025-07-16T10:00:00.000Z' }),
                        JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 100 } }, timestamp: '2025-07-16T10:00:01.000Z' }),
                    ],
                    mtimeOffsetSec: 0,
                },
            ],
        });
        try {
            const result = await detectSessions(rootDir, defaultOptions);
            assert.equal(result.length, 3);

            // Third (mtime=now) first, second (60s ago) second, first (120s ago) third
            assert.equal(result[0].projectName, 'third');
            assert.equal(result[1].projectName, 'second');
            assert.equal(result[2].projectName, 'first');
        } finally {
            cleanup();
        }
    });

    it('respects custom idleTimeout option', async () => {
        const { rootDir, cleanup } = makeTempProjectsDir({
            'C--dev-proj': [
                {
                    name: 'sess001.jsonl',
                    lines: [
                        JSON.stringify({ type: 'user', message: { content: 'hi' }, timestamp: '2025-07-15T10:00:00.000Z' }),
                        JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 100 } }, timestamp: '2025-07-15T10:00:01.000Z' }),
                    ],
                    mtimeOffsetSec: 100, // 100s ago
                },
            ],
        });
        try {
            // With 180s default timeout → should be included (100s < 180s)
            const resultDefault = await detectSessions(rootDir, defaultOptions);
            assert.equal(resultDefault.length, 1);

            // With 50s timeout → should be excluded (100s > 50s)
            const resultShort = await detectSessions(rootDir, {
                ...defaultOptions,
                idleTimeout: 50,
            });
            assert.deepEqual(resultShort, []);
        } finally {
            cleanup();
        }
    });

    it('correctly parses Unix-style project paths', async () => {
        const { rootDir, cleanup } = makeTempProjectsDir({
            '-Users-name-my-project': [
                {
                    name: 'unix001.jsonl',
                    lines: [
                        JSON.stringify({ type: 'user', message: { content: 'unix test' }, timestamp: '2025-07-15T10:00:00.000Z' }),
                        JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 100 } }, timestamp: '2025-07-15T10:00:01.000Z' }),
                    ],
                },
            ],
        });
        try {
            const result = await detectSessions(rootDir, defaultOptions);
            assert.equal(result.length, 1);
            assert.equal(result[0].projectPath, '/Users/name/my/project');
            assert.equal(result[0].projectName, 'my-project');
        } finally {
            cleanup();
        }
    });
});
