import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BarItem, describeStatusBar, StatusBarFacts } from './statusBar';
import { SessionInfo } from './sessions';
import { Settings, SETTINGS_DEFAULTS } from './settings';
import { UsageData, UsageMeter } from './usage';

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

const USAGE_KEY = 'claudeContextBar.usage';
const MISSING_DIR_KEY = 'claudeContextBar.missingDir';

/**
 * A refresh's facts, defaulted to the quietest bar there is: no sessions, no
 * usage, and a projects directory that is where it should be. A case names
 * only the facts it is about.
 */
function facts(overrides: Partial<StatusBarFacts> = {}): StatusBarFacts {
    return {
        sessions: [],
        usage: null,
        settings: SETTINGS_DEFAULTS,
        now: NOW,
        projectsDir: '/home/dev/.claude/projects',
        projectsDirMissing: false,
        configDirExplicit: false,
        ...overrides,
    };
}

/** The one item these facts produce; fails loudly if there is not exactly one. */
function soleItem(overrides: Partial<StatusBarFacts> = {}): BarItem {
    const items = describeStatusBar(facts(overrides));
    assert.equal(items.length, 1, 'expected exactly one Bar item');
    return items[0];
}

/** The bar these sessions produce under a Settings snapshot patched this far. */
function bar(sessions: SessionInfo[], overrides: Partial<Settings> = {}): BarItem[] {
    return describeStatusBar(facts({ sessions, settings: { ...SETTINGS_DEFAULTS, ...overrides } }));
}

/** The one item these sessions produce; fails loudly if there is not exactly one. */
function soleSessionItem(sessions: SessionInfo[], overrides: Partial<Settings> = {}): BarItem {
    return soleItem({ sessions, settings: { ...SETTINGS_DEFAULTS, ...overrides } });
}

/** One usage meter. `resetsAt` is an ISO string, or null for "no reset known". */
function meter(label: string, percentage: number, resetsAt: string | null = null): UsageMeter {
    return {
        key: label,
        label,
        percentage,
        resetsAt: resetsAt === null ? null : new Date(resetsAt),
        isActive: false,
    };
}

/** Usage data whose session meter is the first of the meters given. */
function usage(...meters: UsageMeter[]): UsageData {
    return { session: meters[0] ?? null, meters };
}

/** The usage tooltip these meters produce at `now`. */
function usageTooltip(meters: UsageMeter[], now: number = NOW): string {
    return soleItem({ usage: usage(...meters), now }).tooltip;
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
        assert.equal(soleSessionItem([session({ project: 'notes', tokens: 600 })]).text, '🧠 notes: 600');
    });

    it('drops the emoji and its space when showEmoji is off', () => {
        assert.equal(soleSessionItem([session()], { showEmoji: false }).text, 'notes: 600');
    });

    it('hands each item a command that hides that session', () => {
        const s = session();

        assert.deepEqual(soleSessionItem([s]).command, {
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
        const item = soleSessionItem([session({ project: 'notes-2', base: 'notes' })]);

        assert.equal(item.text, '🧠 notes-2: 600');
    });

    it('ignores the session title', () => {
        const item = soleSessionItem([session({ title: 'Refactor the parser' })]);

        assert.equal(item.text, '🧠 notes: 600');
    });

    it('does not truncate a long project name', () => {
        const item = soleSessionItem([session({ project: 'a-really-quite-long-project-name' })], { showEmoji: false });

        assert.equal(item.text, 'a-really-quite-long-project-name: 600');
    });

    it('shortens a single word to its initial plus its last syllable in compact mode', () => {
        const item = soleSessionItem([session({ project: 'webapp' })], { compactMode: true, showEmoji: false });

        assert.equal(item.text, 'Wbapp: 600');
    });

    it('shortens a multi-word name to an acronym in compact mode', () => {
        const item = soleSessionItem([session({ project: 'my-cool-project' })], { compactMode: true, showEmoji: false });

        assert.equal(item.text, 'MCP: 600');
    });

    it('leaves a name of five characters or fewer alone in compact mode', () => {
        const item = soleSessionItem([session({ project: 'notes' })], { compactMode: true, showEmoji: false });

        assert.equal(item.text, 'notes: 600');
    });

    it('keeps the numeric suffix when it shortens', () => {
        const item = soleSessionItem([session({ project: 'my-cool-project-2' })], { compactMode: true, showEmoji: false });

        assert.equal(item.text, 'MCP-2: 600');
    });

    it('takes a custom short name over the syllable rules', () => {
        const item = soleSessionItem([session({ project: 'my-cool-project' })], {
            compactMode: true,
            showEmoji: false,
            shortNames: { 'my-cool-project': 'Cool' },
        });

        assert.equal(item.text, 'Cool: 600');
    });

    it('appends the numeric suffix to a custom short name matched on the base', () => {
        const item = soleSessionItem([session({ project: 'my-cool-project-3' })], {
            compactMode: true,
            showEmoji: false,
            shortNames: { 'my-cool-project': 'Cool' },
        });

        assert.equal(item.text, 'Cool-3: 600');
    });
});

describe('describeStatusBar — display name in session mode', () => {
    it('labels an item with the session title', () => {
        const item = soleSessionItem([session({ title: 'Refactor the parser' })], { label: 'session', showEmoji: false });

        assert.equal(item.text, 'Refactor the parser: 600');
    });

    it('falls back to the un-numbered project name when there is no title', () => {
        const item = soleSessionItem([session({ project: 'notes-2', base: 'notes' })], { label: 'session', showEmoji: false });

        assert.equal(item.text, 'notes: 600');
    });

    it('treats a whitespace-only title as no title at all', () => {
        const item = soleSessionItem([session({ title: '   ' })], { label: 'session', showEmoji: false });

        assert.equal(item.text, 'notes: 600');
    });

    it('truncates a title past 24 characters, ellipsis included', () => {
        const item = soleSessionItem(
            [session({ title: 'Refactor the whole status bar module' })],
            { label: 'session', showEmoji: false },
        );

        assert.equal(item.text, 'Refactor the whole stat…: 600');
    });

    it('drops the space a truncation happens to land on', () => {
        // The cut falls between "video" and "upscaling", so the ellipsis must
        // not be left hanging after a space.
        const item = soleSessionItem(
            [session({ title: 'Research 480p AI video upscaling' })],
            { label: 'session', showEmoji: false },
        );

        assert.equal(item.text, 'Research 480p AI video…: 600');
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
        assert.equal(soleSessionItem([session({ project: 'crypto-trade' })]).text.slice(0, 2), '🔐');
    });

    it('matches a keyword anywhere in the name, not only on word boundaries', () => {
        // `metadata` contains `data`, so this lands on the data & ML row.
        assert.equal(soleSessionItem([session({ project: 'metadata-viewer' })]).text.slice(0, 2), '🤖');
    });

    it('falls back to the brain when no keyword matches', () => {
        assert.equal(soleSessionItem([session({ project: 'notes' })]).text.slice(0, 2), '🧠');
    });

    it('matches case-insensitively', () => {
        assert.equal(soleSessionItem([session({ project: 'MyGameEngine' })]).text.slice(0, 2), '🎮');
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
        assert.equal(soleSessionItem([session({ tokens: 119_000 })]).background, 'normal');
    });

    it('reads warning at the warning threshold', () => {
        assert.equal(soleSessionItem([session({ tokens: 120_000 })]).background, 'warning');
    });

    it('reads danger at the danger threshold', () => {
        assert.equal(soleSessionItem([session({ tokens: 150_000 })]).background, 'danger');
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
        const item = soleSessionItem([session({ tokens: 900_000 })], { warningTokens: 0, dangerTokens: 0 });

        assert.equal(item.background, 'normal');
    });
});

describe('describeStatusBar — token counts', () => {
    it('reads a count below a thousand verbatim', () => {
        assert.equal(soleSessionItem([session({ tokens: 42 })]).text, '🧠 notes: 42');
    });

    it('rounds a count in the thousands to K', () => {
        assert.equal(soleSessionItem([session({ tokens: 185_400 })]).text, '🧠 notes: 185K');
    });

    it('gives a count in the millions one decimal place', () => {
        assert.equal(soleSessionItem([session({ tokens: 1_200_000 })]).text, '🧠 notes: 1.2M');
    });
});

describe('describeStatusBar — session tooltip', () => {
    it('opens with the numbered project name and the session id', () => {
        const s = session({ project: 'notes-2', base: 'notes' });
        const item = soleSessionItem([s]);

        assert.ok(item.tooltip.startsWith(`**notes-2** (${s.sessionId})\n\n`));
    });

    it('carries the title line when the session has a title', () => {
        const item = soleSessionItem([session({ title: 'Refactor the parser' })]);

        assert.ok(item.tooltip.includes('🏷️ **Refactor the parser**\n\n'));
    });

    it('omits the title line when the session has no title', () => {
        assert.ok(!soleSessionItem([session()]).tooltip.includes('🏷️'));
    });

    it('quotes the first message with a trailing ellipsis', () => {
        const item = soleSessionItem([session({ firstMessage: 'fix the parser' })]);

        assert.ok(item.tooltip.includes('💬 *"fix the parser..."*\n\n'));
    });

    it('omits the first-message line when there is none', () => {
        assert.ok(!soleSessionItem([session()]).tooltip.includes('💬'));
    });

    it('shows the project path and the model', () => {
        const item = soleSessionItem([session({ path: '/home/dev/notes', model: 'claude-opus-5' })]);

        assert.ok(item.tooltip.includes('📁 `/home/dev/notes`\n\n'));
        assert.ok(item.tooltip.includes('🤖 Model: `claude-opus-5`\n\n'));
    });

    it('reads the model as Unknown when the transcript never named one', () => {
        assert.ok(soleSessionItem([session({ model: '' })]).tooltip.includes('🤖 Model: `Unknown`\n\n'));
    });

    it('states the context usage as a percentage and an abbreviated count', () => {
        const item = soleSessionItem([session({ tokens: 185_400, percentage: 93 })]);

        assert.ok(item.tooltip.includes('📊 **Context Usage: 93%** (185K)\n\n'));
    });

    it('tables the cache reads, the cache writes and the total against the limit', () => {
        const item = soleSessionItem([session({
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
        const item = soleSessionItem([s]);

        assert.ok(item.tooltip.includes(`🕐 Last updated: ${s.lastUpdated.toLocaleTimeString()}\n\n`));
    });

    it('closes by telling the user a click hides the item', () => {
        assert.ok(soleSessionItem([session()]).tooltip.endsWith('*Click to hide*'));
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

describe('describeStatusBar — the whole bar', () => {
    it('describes nothing when there are no sessions, no usage and no warning', () => {
        assert.deepEqual(describeStatusBar(facts()), []);
    });

    it('orders the warning, then the sessions, then the subscription usage', () => {
        const a = session({ project: 'alpha' });
        const b = session({ project: 'beta' });
        const items = describeStatusBar(facts({
            sessions: [a, b],
            usage: usage(meter('Session (5h)', 7)),
            projectsDirMissing: true,
            configDirExplicit: true,
        }));

        assert.deepEqual(keys(items), [MISSING_DIR_KEY, a.sessionFile, b.sessionFile, USAGE_KEY]);
    });

    it('ranks that order by priority too, higher sitting further left', () => {
        const items = describeStatusBar(facts({
            sessions: [session(), session()],
            usage: usage(meter('Session (5h)', 7)),
            projectsDirMissing: true,
            configDirExplicit: true,
        }));

        assert.deepEqual(priorities(items), [910, 902, 901, 900]);
    });

    it('keeps the usage item to the right of a full five sessions', () => {
        const items = describeStatusBar(facts({
            sessions: [session(), session(), session(), session(), session()],
            usage: usage(meter('Session (5h)', 7)),
        }));

        assert.deepEqual(priorities(items), [905, 904, 903, 902, 901, 900]);
    });
});

describe('describeStatusBar — subscription usage item', () => {
    it('reads as Claude\'s icon and the session meter\'s percentage', () => {
        const item = soleItem({ usage: usage(meter('Session (5h)', 7)) });

        assert.equal(item.key, USAGE_KEY);
        assert.equal(item.text, '✴️ 7%');
    });

    it('carries neither a colour nor a click', () => {
        const item = soleItem({ usage: usage(meter('Session (5h)', 7)) });

        assert.equal(item.color, undefined);
        assert.equal(item.command, undefined);
    });

    it('does not appear when no usage has been fetched', () => {
        assert.deepEqual(describeStatusBar(facts({ usage: null })), []);
    });

    it('does not appear when the fetched usage has no session meter', () => {
        const weekly = meter('Weekly (all models)', 40);

        assert.deepEqual(describeStatusBar(facts({ usage: { session: null, meters: [weekly] } })), []);
    });

    it('appears on the data alone, without re-reading showUsage', () => {
        // `showUsage` is judged where the fetch happens, which clears the data
        // when it is off. A second opinion here could only disagree.
        const items = describeStatusBar(facts({
            usage: usage(meter('Session (5h)', 7)),
            settings: { ...SETTINGS_DEFAULTS, showUsage: false },
        }));

        assert.deepEqual(texts(items), ['✴️ 7%']);
    });
});

describe('describeStatusBar — subscription usage background', () => {
    const at = (percentage: number, overrides: Partial<Settings> = {}): string =>
        soleItem({
            usage: usage(meter('Session (5h)', percentage)),
            settings: { ...SETTINGS_DEFAULTS, ...overrides },
        }).background;

    it('reads normal below the warning threshold', () => {
        assert.equal(at(49), 'normal');
    });

    it('reads warning at the warning threshold', () => {
        assert.equal(at(50), 'warning');
    });

    it('reads danger at the danger threshold', () => {
        assert.equal(at(75), 'danger');
    });

    it('grades on a percentage where a session item grades on absolute tokens', () => {
        // The same 90% of the window: the session item stays normal because
        // 90K is under the 120K token threshold, while the usage item goes
        // danger because 90 is over the 75 percent one. Two units, one
        // vocabulary.
        const items = describeStatusBar(facts({
            sessions: [session({ tokens: 90_000, contextLimit: 100_000, percentage: 90 })],
            usage: usage(meter('Session (5h)', 90)),
        }));

        assert.deepEqual(backgrounds(items), ['normal', 'danger']);
    });

    it('treats a zero threshold as met rather than as switched off', () => {
        // Pinned, not endorsed; see #64. The token path reads a zero threshold
        // as "never colour"; this one reads it as "always colour", so a user
        // who zeroes it to switch it off gets the opposite.
        assert.equal(at(0, { usageWarningThreshold: 0 }), 'warning');
    });
});

describe('describeStatusBar — subscription usage tooltip', () => {
    it('opens with the heading and the table header', () => {
        const tooltip = usageTooltip([meter('Session (5h)', 7)]);

        assert.ok(tooltip.startsWith('⚡ **Claude Usage**\n\n| Limit | Used | Resets |\n|------|------|------|\n'));
    });

    it('gives every meter a row, not just the session one', () => {
        const tooltip = usageTooltip([meter('Session (5h)', 7), meter('Weekly (all models)', 40)]);

        assert.ok(tooltip.includes('| Session (5h) | **7%** |  |\n| Weekly (all models) | **40%** |  |'));
    });

    it('closes by naming where the numbers come from', () => {
        assert.ok(usageTooltip([meter('Session (5h)', 7)]).endsWith('\n\n*Subscription rate limits (`/usage`)*'));
    });

    it('counts a reset more than a day out in whole days', () => {
        const tooltip = usageTooltip([meter('Session (5h)', 7, '2026-01-04T13:00:00Z')]);

        assert.ok(tooltip.includes('| Session (5h) | **7%** | resets in 3d |'));
    });

    it('still counts in days when the last day is all but over', () => {
        // 47h59m: the hours are floored before the days are, so this is 1d.
        const tooltip = usageTooltip([meter('Session (5h)', 7, '2026-01-03T12:29:00Z')]);

        assert.ok(tooltip.includes('| Session (5h) | **7%** | resets in 1d |'));
    });

    it('counts a reset later the same day in whole hours', () => {
        const tooltip = usageTooltip([meter('Session (5h)', 7, '2026-01-01T18:00:00Z')]);

        assert.ok(tooltip.includes('| Session (5h) | **7%** | resets in 5h |'));
    });

    it('counts a reset within the hour in minutes', () => {
        const tooltip = usageTooltip([meter('Session (5h)', 7, '2026-01-01T12:50:00Z')]);

        assert.ok(tooltip.includes('| Session (5h) | **7%** | resets in 20m |'));
    });

    it('rounds a reset seconds away up to a minute rather than to none', () => {
        const tooltip = usageTooltip([meter('Session (5h)', 7, '2026-01-01T12:30:20Z')]);

        assert.ok(tooltip.includes('| Session (5h) | **7%** | resets in 1m |'));
    });

    it('says a reset already due is resetting', () => {
        const tooltip = usageTooltip([meter('Session (5h)', 7, '2026-01-01T12:00:00Z')]);

        assert.ok(tooltip.includes('| Session (5h) | **7%** | resetting |'));
    });

    it('leaves the cell empty when no reset time is known', () => {
        const tooltip = usageTooltip([meter('Session (5h)', 7, null)]);

        assert.ok(tooltip.includes('| Session (5h) | **7%** |  |'));
    });

    it('reads the clock off the facts, not off the machine', () => {
        // The same meter, two `now`s: the arithmetic is driven from outside.
        const m = meter('Session (5h)', 7, '2026-01-01T18:00:00Z');

        assert.ok(usageTooltip([m], Date.parse('2026-01-01T12:30:00Z')).includes('resets in 5h |'));
        assert.ok(usageTooltip([m], Date.parse('2026-01-01T17:30:00Z')).includes('resets in 30m |'));
    });
});

describe('describeStatusBar — missing config directory warning', () => {
    const missing = (overrides: Partial<StatusBarFacts> = {}): Partial<StatusBarFacts> => ({
        projectsDirMissing: true,
        configDirExplicit: true,
        ...overrides,
    });

    it('warns when a directory the user named holds no projects', () => {
        const item = soleItem(missing());

        assert.equal(item.key, MISSING_DIR_KEY);
        assert.equal(item.text, '⚠️ Claude config dir');
        assert.equal(item.background, 'normal');
        assert.equal(item.command, undefined);
    });

    it('names the path it looked in', () => {
        const item = soleItem(missing({ projectsDir: '/opt/claude/projects' }));

        assert.ok(item.tooltip.startsWith('Claude Context Bar could not find `/opt/claude/projects`.\n\n'));
    });

    it('names both ways of pointing it somewhere else', () => {
        const item = soleItem(missing());

        assert.ok(item.tooltip.includes('`claudeContextBar.configDir`'));
        assert.ok(item.tooltip.includes('`CLAUDE_CONFIG_DIR`'));
    });

    it('does not appear when the directory is there', () => {
        assert.deepEqual(describeStatusBar(facts(missing({ projectsDirMissing: false }))), []);
    });

    it('does not appear when the user never named a directory', () => {
        // On the default `~/.claude` an absent `projects/` means Claude Code
        // has not run yet, which is not something to warn about.
        assert.deepEqual(describeStatusBar(facts(missing({ configDirExplicit: false }))), []);
    });

    it('sits left of the sessions it is explaining the absence of', () => {
        const items = describeStatusBar(facts(missing({ sessions: [session()] })));

        assert.deepEqual(keys(items), [MISSING_DIR_KEY, items[1].key]);
        assert.ok(priorities(items)[0] > priorities(items)[1]);
    });
});
