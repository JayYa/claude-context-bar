import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { selectActiveSessions, SessionInfo } from './sessions';

// --- fixtures ---------------------------------------------------------------
//
// Only four fields matter to the selection: the project name it groups on, the
// creation time, the last update, and whether the session ended on a `/clear`.
// `session()` fills the rest with values the selection never reads, so a case
// says only what it is about.

let nextSessionId = 0;

interface SessionOverrides {
    project?: string;
    created?: string | null;
    updated?: string;
    cleared?: boolean;
}

function session(overrides: SessionOverrides = {}): SessionInfo {
    const id = `session-${++nextSessionId}`;
    const created = overrides.created === undefined ? '2026-01-01T10:00:00Z' : overrides.created;

    return {
        projectName: overrides.project ?? 'webapp',
        projectPath: '/home/dev/webapp',
        sessionId: id.substring(0, 8),
        sessionFile: `/home/dev/.claude/projects/webapp/${id}.jsonl`,
        inputTokens: 100,
        cacheReadTokens: 200,
        cacheCreationTokens: 300,
        totalTokens: 600,
        percentage: 1,
        lastUpdated: new Date(overrides.updated ?? '2026-01-01T12:00:00Z'),
        model: 'claude-opus-5',
        contextLimit: 200_000,
        firstMessage: 'do the thing',
        sessionCreated: created === null ? null : new Date(created),
        wasCleared: overrides.cleared ?? false
    };
}

/** The display names that came back, in the order the caller was given them. */
function names(sessions: SessionInfo[]): string[] {
    return sessions.map(s => s.projectName);
}

/** The session files that came back, as a set: return order is not promised. */
function files(sessions: SessionInfo[]): Set<string> {
    return new Set(sessions.map(s => s.sessionFile));
}

// --- tests ------------------------------------------------------------------

describe('selectActiveSessions — superseded by /clear', () => {
    it('hides a session that ended on a /clear', () => {
        const cleared = session({ cleared: true });

        assert.deepEqual(selectActiveSessions([cleared]), []);
    });

    it('keeps a session that was not left on a /clear', () => {
        // Narrow on purpose: all this pins is that `wasCleared: false`
        // survives selection. The seam sees only that boolean, so "a `/clear`
        // followed by more work" is indistinguishable here from "no `/clear`
        // at all". Whether a later user message resets `wasCleared` is the
        // transcript module's business, covered by `src/transcript.test.ts`
        // ("is not cleared when a user message follows the /clear").
        const notCleared = session({ cleared: false });

        assert.deepEqual(names(selectActiveSessions([notCleared])), ['webapp']);
    });

    it('keeps an Active sibling when the other session was cleared', () => {
        const cleared = session({ created: '2026-01-01T09:00:00Z', cleared: true });
        const stillActive = session({ created: '2026-01-01T11:00:00Z' });

        assert.deepEqual(files(selectActiveSessions([cleared, stillActive])), files([stillActive]));
    });
});

describe('selectActiveSessions — superseded by a newer session', () => {
    it('hides a session displaced by one created after its last update', () => {
        const superseded = session({
            created: '2026-01-01T09:00:00Z',
            updated: '2026-01-01T09:30:00Z'
        });
        const successor = session({
            created: '2026-01-01T10:00:00Z',
            updated: '2026-01-01T12:00:00Z'
        });

        assert.deepEqual(files(selectActiveSessions([superseded, successor])), files([successor]));
    });

    it('keeps a session whose newer sibling was created before its last update', () => {
        // Both tabs are in use: the user went back to the older session after
        // starting the newer one, so neither one is Superseded.
        const older = session({
            created: '2026-01-01T09:00:00Z',
            updated: '2026-01-01T12:00:00Z'
        });
        const newer = session({
            created: '2026-01-01T10:00:00Z',
            updated: '2026-01-01T11:00:00Z'
        });

        assert.equal(selectActiveSessions([older, newer]).length, 2);
    });

    it('keeps two Active sessions in one project', () => {
        const first = session({
            created: '2026-01-01T09:00:00Z',
            updated: '2026-01-01T12:00:00Z'
        });
        const second = session({
            created: '2026-01-01T10:00:00Z',
            updated: '2026-01-01T12:00:00Z'
        });

        const active = selectActiveSessions([first, second]);

        assert.deepEqual(files(active), files([first, second]));
    });

    it('does not let a session in another project displace this one', () => {
        const supersededLooking = session({
            project: 'webapp',
            created: '2026-01-01T09:00:00Z',
            updated: '2026-01-01T09:30:00Z'
        });
        const elsewhere = session({
            project: 'api',
            created: '2026-01-01T11:00:00Z',
            updated: '2026-01-01T12:00:00Z'
        });

        const active = selectActiveSessions([supersededLooking, elsewhere]);

        assert.deepEqual(files(active), files([supersededLooking, elsewhere]));
    });
});

describe('selectActiveSessions — display names', () => {
    it('leaves a project with one Active session unsuffixed', () => {
        assert.deepEqual(names(selectActiveSessions([session({ project: 'webapp' })])), ['webapp']);
    });

    it('numbers by creation order, oldest unsuffixed', () => {
        const newer = session({
            project: 'webapp',
            created: '2026-01-01T10:00:00Z',
            updated: '2026-01-01T12:00:00Z'
        });
        const older = session({
            project: 'webapp',
            created: '2026-01-01T09:00:00Z',
            updated: '2026-01-01T12:00:00Z'
        });

        const active = selectActiveSessions([newer, older]);
        const nameOf = (s: SessionInfo) =>
            active.find(a => a.sessionFile === s.sessionFile)!.projectName;

        assert.equal(nameOf(older), 'webapp');
        assert.equal(nameOf(newer), 'webapp-2');
    });

    it('numbers each project independently', () => {
        const webapp1 = session({ project: 'webapp', created: '2026-01-01T09:00:00Z', updated: '2026-01-01T12:00:00Z' });
        const webapp2 = session({ project: 'webapp', created: '2026-01-01T10:00:00Z', updated: '2026-01-01T12:00:00Z' });
        const api1 = session({ project: 'api', created: '2026-01-01T09:30:00Z', updated: '2026-01-01T12:00:00Z' });
        const api2 = session({ project: 'api', created: '2026-01-01T10:30:00Z', updated: '2026-01-01T12:00:00Z' });

        const active = selectActiveSessions([webapp1, api1, webapp2, api2]);
        const nameOf = (s: SessionInfo) =>
            active.find(a => a.sessionFile === s.sessionFile)!.projectName;

        assert.equal(nameOf(webapp1), 'webapp');
        assert.equal(nameOf(webapp2), 'webapp-2');
        assert.equal(nameOf(api1), 'api');
        assert.equal(nameOf(api2), 'api-2');
    });

    it('numbers only the sessions that survived filtering', () => {
        // The cleared session is gone before numbering starts, so the two that
        // remain are named as if it had never been there.
        const oldest = session({ project: 'webapp', created: '2026-01-01T09:00:00Z', updated: '2026-01-01T12:00:00Z' });
        const cleared = session({ project: 'webapp', created: '2026-01-01T09:30:00Z', updated: '2026-01-01T12:00:00Z', cleared: true });
        const newest = session({ project: 'webapp', created: '2026-01-01T10:00:00Z', updated: '2026-01-01T12:00:00Z' });

        const active = selectActiveSessions([oldest, cleared, newest]);

        assert.deepEqual(new Set(names(active)), new Set(['webapp', 'webapp-2']));
    });
});

describe('selectActiveSessions — input handling', () => {
    it('returns nothing for an empty collection', () => {
        assert.deepEqual(selectActiveSessions([]), []);
    });

    it('gives the same answer when called twice on the same collection', () => {
        // Numbering returns new session values rather than renaming what it
        // was handed, so a fixture survives being reused across cases.
        //
        // Three siblings handed over out of creation order is what makes this
        // bite. An implementation that renamed the caller's objects would
        // leave them named `webapp`, `webapp-2`, `webapp-3`, so the second
        // call would group them as three separate one-session projects and
        // hand back a different answer. Only the return value is inspected;
        // the input objects are not the contract.
        const oldest = session({ project: 'webapp', created: '2026-01-01T09:00:00Z', updated: '2026-01-01T12:00:00Z' });
        const middle = session({ project: 'webapp', created: '2026-01-01T10:00:00Z', updated: '2026-01-01T12:00:00Z' });
        const newest = session({ project: 'webapp', created: '2026-01-01T11:00:00Z', updated: '2026-01-01T12:00:00Z' });
        const collection = [newest, oldest, middle];

        const once = selectActiveSessions(collection);
        const twice = selectActiveSessions(collection);

        assert.deepEqual(twice, once);
        assert.deepEqual(names(twice), ['webapp', 'webapp-2', 'webapp-3']);
    });
});

describe('selectActiveSessions — characterization', () => {
    // CHARACTERIZATION: a session whose creation time did not parse is treated
    // as created at the Unix epoch, which sorts it last within its project and
    // makes it Superseded by any sibling created after its last update. Nobody
    // chose this; it falls out of a `|| 0` fallback. Recorded here as a known
    // quirk, deliberately left unchanged by the extraction.
    // Follow-up: https://github.com/JayYa/claude-context-bar/issues/45
    it('treats a session with no parseable creation time as created at the epoch', () => {
        const noCreationTime = session({
            project: 'webapp',
            created: null,
            updated: '2026-01-01T12:00:00Z'
        });
        const normal = session({
            project: 'webapp',
            created: '2026-01-01T13:00:00Z',
            updated: '2026-01-01T13:30:00Z'
        });

        const active = selectActiveSessions([noCreationTime, normal]);

        assert.deepEqual(files(active), files([normal]));
    });

    // CHARACTERIZATION: same quirk, seen through the numbering. With nothing
    // newer to displace it, an epoch-zero session survives, and sorts as the
    // oldest — so it takes the bare project name from a session that really is
    // older. See the follow-up above.
    it('numbers a session with no parseable creation time as the oldest', () => {
        const noCreationTime = session({
            project: 'webapp',
            created: null,
            updated: '2026-01-01T14:00:00Z'
        });
        const realSession = session({
            project: 'webapp',
            created: '2026-01-01T09:00:00Z',
            updated: '2026-01-01T14:00:00Z'
        });

        const active = selectActiveSessions([noCreationTime, realSession]);
        const nameOf = (s: SessionInfo) =>
            active.find(a => a.sessionFile === s.sessionFile)!.projectName;

        assert.equal(nameOf(noCreationTime), 'webapp');
        assert.equal(nameOf(realSession), 'webapp-2');
    });
});
