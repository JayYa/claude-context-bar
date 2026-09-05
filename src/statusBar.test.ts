import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BarItem, describeStatusBar } from './statusBar';
import { SessionInfo } from './sessions';
import { Settings, SETTINGS_DEFAULTS } from './settings';

// --- fixtures ---------------------------------------------------------------
//
// A session reaches the bar with fifteen fields; the display reads fourteen of
// them and most cases care about two. `session()` fills the rest with values
// that keep the derived text stable — the default project name matches no
// emoji keyword and its token count is below every threshold — so a case says
// only what it is about.

let nextSessionId = 0;

interface SessionOverrides {
    project?: string;
    base?: string;
    title?: string;
    tokens?: number;
    cacheRead?: number;
    cacheCreation?: number;
    percentage?: number;
    contextLimit?: number;
    model?: string;
    firstMessage?: string;
    path?: string;
    updated?: string;
}

function session(overrides: SessionOverrides = {}): SessionInfo {
    const id = `session-${++nextSessionId}`;
    const project = overrides.project ?? 'notes';

    return {
        projectName: project,
        baseProjectName: overrides.base ?? project,
        sessionTitle: overrides.title ?? '',
        projectPath: overrides.path ?? '/home/dev/notes',
        sessionId: id.substring(0, 8),
        sessionFile: `/home/dev/.claude/projects/notes/${id}.jsonl`,
        inputTokens: 100,
        cacheReadTokens: overrides.cacheRead ?? 200,
        cacheCreationTokens: overrides.cacheCreation ?? 300,
        totalTokens: overrides.tokens ?? 600,
        percentage: overrides.percentage ?? 1,
        lastUpdated: new Date(overrides.updated ?? '2026-01-01T12:00:00Z'),
        model: overrides.model ?? 'claude-opus-5',
        contextLimit: overrides.contextLimit ?? 200_000,
        firstMessage: overrides.firstMessage ?? '',
        sessionCreated: new Date('2026-01-01T10:00:00Z'),
        wasCleared: false,
    };
}

const NOW = Date.parse('2026-01-01T12:30:00Z');

/** The bar these sessions produce under a Settings snapshot patched this far. */
function bar(sessions: SessionInfo[], overrides: Partial<Settings> = {}): BarItem[] {
    const settings: Settings = { ...SETTINGS_DEFAULTS, ...overrides };
    return describeStatusBar({ sessions, settings, now: NOW });
}

/** The one item these sessions produce; fails loudly if there is not exactly one. */
function only(sessions: SessionInfo[], overrides: Partial<Settings> = {}): BarItem {
    const items = bar(sessions, overrides);
    assert.equal(items.length, 1, 'expected exactly one Bar item');
    return items[0];
}

const texts = (items: BarItem[]): string[] => items.map(i => i.text);
const keys = (items: BarItem[]): string[] => items.map(i => i.key);
const colors = (items: BarItem[]): (string | undefined)[] => items.map(i => i.color);
const backgrounds = (items: BarItem[]): string[] => items.map(i => i.background);
const priorities = (items: BarItem[]): number[] => items.map(i => i.priority);

// --- tests ------------------------------------------------------------------

describe('describeStatusBar — session items', () => {
    it('describes nothing when there are no sessions', () => {
        assert.deepEqual(bar([]), []);
    });

    it('describes one item per session, keyed by its session file', () => {
        const a = session();
        const b = session();

        assert.deepEqual(keys(bar([a, b])), [a.sessionFile, b.sessionFile]);
    });

    it('reads as emoji, display name and token count', () => {
        assert.equal(only([session({ project: 'notes', tokens: 600 })]).text, '🧠 notes: 600');
    });

    it('drops the emoji and its space when showEmoji is off', () => {
        assert.equal(only([session()], { showEmoji: false }).text, 'notes: 600');
    });

    it('hands each item a command that hides that session', () => {
        const s = session();

        assert.deepEqual(only([s]).command, {
            command: 'claudeContextBar.hideSession',
            title: 'Hide Session',
            arguments: [s.sessionFile],
        });
    });
});

describe('describeStatusBar — priority', () => {
    it('counts down from the base so the first session sits leftmost', () => {
        const items = bar([session(), session(), session()]);

        assert.deepEqual(priorities(items), [903, 902, 901]);
    });

    it('leaves the base priority itself free for the item to their right', () => {
        // 900 is the subscription usage item's, added by #68. A single session
        // must not take it.
        assert.deepEqual(priorities(bar([session()])), [901]);
    });
});

describe('describeStatusBar — display name in project mode', () => {
    it('labels an item with the numbered project name', () => {
        const item = only([session({ project: 'notes-2', base: 'notes' })]);

        assert.equal(item.text, '🧠 notes-2: 600');
    });

    it('ignores the session title', () => {
        const item = only([session({ title: 'Refactor the parser' })]);

        assert.equal(item.text, '🧠 notes: 600');
    });

    it('does not truncate a long project name', () => {
        const item = only([session({ project: 'a-really-quite-long-project-name' })], { showEmoji: false });

        assert.equal(item.text, 'a-really-quite-long-project-name: 600');
    });

    it('shortens a single word to its initial plus its last syllable in compact mode', () => {
        const item = only([session({ project: 'webapp' })], { compactMode: true, showEmoji: false });

        assert.equal(item.text, 'Wbapp: 600');
    });

    it('shortens a multi-word name to an acronym in compact mode', () => {
        const item = only([session({ project: 'my-cool-project' })], { compactMode: true, showEmoji: false });

        assert.equal(item.text, 'MCP: 600');
    });

    it('leaves a name of five characters or fewer alone in compact mode', () => {
        const item = only([session({ project: 'notes' })], { compactMode: true, showEmoji: false });

        assert.equal(item.text, 'notes: 600');
    });

    it('keeps the numeric suffix when it shortens', () => {
        const item = only([session({ project: 'my-cool-project-2' })], { compactMode: true, showEmoji: false });

        assert.equal(item.text, 'MCP-2: 600');
    });

    it('takes a custom short name over the syllable rules', () => {
        const item = only([session({ project: 'my-cool-project' })], {
            compactMode: true,
            showEmoji: false,
            shortNames: { 'my-cool-project': 'Cool' },
        });

        assert.equal(item.text, 'Cool: 600');
    });

    it('appends the numeric suffix to a custom short name matched on the base', () => {
        const item = only([session({ project: 'my-cool-project-3' })], {
            compactMode: true,
            showEmoji: false,
            shortNames: { 'my-cool-project': 'Cool' },
        });

        assert.equal(item.text, 'Cool-3: 600');
    });
});

describe('describeStatusBar — display name in session mode', () => {
    it('labels an item with the session title', () => {
        const item = only([session({ title: 'Refactor the parser' })], { label: 'session', showEmoji: false });

        assert.equal(item.text, 'Refactor the parser: 600');
    });

    it('falls back to the un-numbered project name when there is no title', () => {
        const item = only([session({ project: 'notes-2', base: 'notes' })], { label: 'session', showEmoji: false });

        assert.equal(item.text, 'notes: 600');
    });

    it('treats a whitespace-only title as no title at all', () => {
        const item = only([session({ title: '   ' })], { label: 'session', showEmoji: false });

        assert.equal(item.text, 'notes: 600');
    });

    it('truncates a title past 24 characters, ellipsis included', () => {
        const item = only(
            [session({ title: 'Refactor the whole status bar module' })],
            { label: 'session', showEmoji: false },
        );

        assert.equal(item.text, 'Refactor the whole stat…: 600');
    });

    it('numbers repeated titles, the first one left bare', () => {
        const items = bar(
            [session({ title: 'Refactor' }), session({ title: 'Refactor' }), session({ title: 'Refactor' })],
            { label: 'session', showEmoji: false },
        );

        assert.deepEqual(texts(items), ['Refactor: 600', 'Refactor-2: 600', 'Refactor-3: 600']);
    });

    it('leaves a title that appears once unnumbered', () => {
        const items = bar(
            [session({ title: 'Refactor' }), session({ title: 'Review' })],
            { label: 'session', showEmoji: false },
        );

        assert.deepEqual(texts(items), ['Refactor: 600', 'Review: 600']);
    });
});

describe('describeStatusBar — emoji', () => {
    it('matches the first keyword row that hits, not the most specific', () => {
        // `crypto` appears under both security and finance; security is listed
        // first, so it wins.
        assert.equal(only([session({ project: 'crypto-trade' })]).text.slice(0, 2), '🔐');
    });

    it('matches a keyword anywhere in the name, not only on word boundaries', () => {
        // `metadata` contains `data`, so this lands on the data & ML row.
        assert.equal(only([session({ project: 'metadata-viewer' })]).text.slice(0, 2), '🤖');
    });

    it('falls back to the brain when no keyword matches', () => {
        assert.equal(only([session({ project: 'notes' })]).text.slice(0, 2), '🧠');
    });

    it('matches case-insensitively', () => {
        assert.equal(only([session({ project: 'MyGameEngine' })]).text.slice(0, 2), '🎮');
    });
});

describe('describeStatusBar — colours', () => {
    it('walks the pastel palette in order of first appearance when autoColor is on', () => {
        const items = bar([session({ project: 'alpha' }), session({ project: 'beta' })]);

        assert.deepEqual(colors(items), ['#a8d8ea', '#d4a5a5']);
    });

    it('walks the chosen base colour shades when autoColor is off', () => {
        const items = bar(
            [session({ project: 'alpha' }), session({ project: 'beta' })],
            { autoColor: false, baseColor: 'Blue' },
        );

        assert.deepEqual(colors(items), ['#a8d8ea', '#9ecfe0']);
    });

    it('falls back to White for a base colour it does not know', () => {
        const items = bar([session({ project: 'alpha' })], { autoColor: false, baseColor: 'Chartreuse' });

        assert.deepEqual(colors(items), ['#ffffff']);
    });

    it('wraps around when there are more names than shades', () => {
        const projects = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'];
        const items = bar(projects.map(project => session({ project })), {
            autoColor: false,
            baseColor: 'Blue',
        });

        assert.equal(colors(items)[5], '#a8d8ea');
    });
});

describe('describeStatusBar — background level', () => {
    it('reads normal below the warning threshold', () => {
        assert.equal(only([session({ tokens: 119_000 })]).background, 'normal');
    });

    it('reads warning at the warning threshold', () => {
        assert.equal(only([session({ tokens: 120_000 })]).background, 'warning');
    });

    it('reads danger at the danger threshold', () => {
        assert.equal(only([session({ tokens: 150_000 })]).background, 'danger');
    });

    it('thresholds on absolute tokens, not on the percentage of the window', () => {
        // Half of a 200K window is well under the 120K warning threshold; half
        // of a 1M window is well over it. The percentage is the same.
        const items = bar([
            session({ tokens: 100_000, contextLimit: 200_000, percentage: 50 }),
            session({ tokens: 500_000, contextLimit: 1_000_000, percentage: 50 }),
        ]);

        assert.deepEqual(backgrounds(items), ['normal', 'danger']);
    });

    it('switches a level off when its threshold is zero', () => {
        const item = only([session({ tokens: 900_000 })], { warningTokens: 0, dangerTokens: 0 });

        assert.equal(item.background, 'normal');
    });
});

describe('describeStatusBar — token counts', () => {
    it('reads a count below a thousand verbatim', () => {
        assert.equal(only([session({ tokens: 42 })]).text, '🧠 notes: 42');
    });

    it('rounds a count in the thousands to K', () => {
        assert.equal(only([session({ tokens: 185_400 })]).text, '🧠 notes: 185K');
    });

    it('gives a count in the millions one decimal place', () => {
        assert.equal(only([session({ tokens: 1_200_000 })]).text, '🧠 notes: 1.2M');
    });
});

describe('describeStatusBar — session tooltip', () => {
    it('opens with the numbered project name and the session id', () => {
        const s = session({ project: 'notes-2', base: 'notes' });
        const item = only([s]);

        assert.ok(item.tooltip.startsWith(`**notes-2** (${s.sessionId})\n\n`));
    });

    it('carries the title line when the session has a title', () => {
        const item = only([session({ title: 'Refactor the parser' })]);

        assert.ok(item.tooltip.includes('🏷️ **Refactor the parser**\n\n'));
    });

    it('omits the title line when the session has no title', () => {
        assert.ok(!only([session()]).tooltip.includes('🏷️'));
    });

    it('quotes the first message with a trailing ellipsis', () => {
        const item = only([session({ firstMessage: 'fix the parser' })]);

        assert.ok(item.tooltip.includes('💬 *"fix the parser..."*\n\n'));
    });

    it('omits the first-message line when there is none', () => {
        assert.ok(!only([session()]).tooltip.includes('💬'));
    });

    it('shows the project path and the model', () => {
        const item = only([session({ path: '/home/dev/notes', model: 'claude-opus-5' })]);

        assert.ok(item.tooltip.includes('📁 `/home/dev/notes`\n\n'));
        assert.ok(item.tooltip.includes('🤖 Model: `claude-opus-5`\n\n'));
    });

    it('reads the model as Unknown when the transcript never named one', () => {
        assert.ok(only([session({ model: '' })]).tooltip.includes('🤖 Model: `Unknown`\n\n'));
    });

    it('states the context usage as a percentage and an abbreviated count', () => {
        const item = only([session({ tokens: 185_400, percentage: 93 })]);

        assert.ok(item.tooltip.includes('📊 **Context Usage: 93%** (185K)\n\n'));
    });

    it('tables the cache reads, the cache writes and the total against the limit', () => {
        const item = only([session({
            tokens: 185_400,
            cacheRead: 150_000,
            cacheCreation: 35_400,
            contextLimit: 200_000,
        })]);

        assert.ok(item.tooltip.includes(
            '| Type | Tokens |\n|------|--------|\n' +
            '| Cache Read | 150K |\n' +
            '| Cache Creation | 35K |\n' +
            '| **Total** | **185K** / 200K |\n\n',
        ));
    });

    it('stamps the last update in local time', () => {
        // The format is the machine's, deliberately: #64 keeps it localized, so
        // the assertion asks the same question the code does.
        const s = session({ updated: '2026-01-01T12:00:00Z' });
        const item = only([s]);

        assert.ok(item.tooltip.includes(`🕐 Last updated: ${s.lastUpdated.toLocaleTimeString()}\n\n`));
    });

    it('closes by telling the user a click hides the item', () => {
        assert.ok(only([session()]).tooltip.endsWith('*Click to hide*'));
    });
});

describe('describeStatusBar — pinned quirks', () => {
    it('can read the same token count either side of the colouring threshold', () => {
        // Pinned, not endorsed; see #64. The count is rounded to the nearest K
        // for display but thresholded exactly, so two items reading "120K"
        // come out differently coloured.
        const items = bar([session({ tokens: 119_600 }), session({ tokens: 120_400 })]);

        assert.deepEqual(texts(items), ['🧠 notes: 120K', '🧠 notes: 120K']);
        assert.deepEqual(backgrounds(items), ['normal', 'warning']);
    });

    it('looks the emoji up on the project name without its numeric suffix', () => {
        // Pinned, not endorsed; see #64. The item is labelled `game-2` but the
        // emoji is chosen from `game`, so a project's sessions never disagree
        // about their icon.
        const items = bar([
            session({ project: 'game', base: 'game' }),
            session({ project: 'game-2', base: 'game' }),
        ]);

        assert.deepEqual(texts(items), ['🎮 game: 600', '🎮 game-2: 600']);
    });

    it('shares one colour between two sessions that end up labelled the same', () => {
        // Pinned, not endorsed; see #64. The palette is keyed on the final
        // display name, so two different projects that compact to one name get
        // one colour between them even though they are plainly two projects.
        const items = bar(
            [session({ project: 'alpha-service' }), session({ project: 'auth-server' })],
            { compactMode: true, shortNames: { 'alpha-service': 'AS', 'auth-server': 'AS' } },
        );

        assert.deepEqual(texts(items), ['🧠 AS: 600', '⚙️ AS: 600']);
        assert.deepEqual(colors(items), ['#a8d8ea', '#a8d8ea']);
        assert.notEqual(keys(items)[0], keys(items)[1]);
    });
});
