import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    StatusBarConfig,
    StatusBarManager,
    StatusBarItemSnapshot,
    VSCodeSurface,
    VSCodeStatusBarItem,
    _test,
} from './statusBarManager';
const {
    getEmojiForProject,
    extractLastSyllable,
    getShortName,
    formatTokens,
    buildSessionText,
    buildTooltip,
    getBackgroundColorId,
    assignProjectColors,
    filterHiddenSessions,
} = _test;
import { SessionInfo } from './sessionDetection';

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Create a minimal SessionInfo object for testing.
 * Only the fields relevant to StatusBarManager are populated.
 */
function makeSession(overrides: Partial<SessionInfo> & { projectName: string }): SessionInfo {
    const now = new Date('2026-07-15T10:00:00Z');
    return {
        projectName: overrides.projectName,
        projectPath: overrides.projectPath || `/home/projects/${overrides.projectName}`,
        sessionId: overrides.sessionId || 'abc12345',
        sessionFile: overrides.sessionFile || `/fake/${overrides.projectName}/abc12345.jsonl`,
        inputTokens: overrides.inputTokens ?? 100,
        cacheReadTokens: overrides.cacheReadTokens ?? 0,
        cacheCreationTokens: overrides.cacheCreationTokens ?? 0,
        totalTokens: overrides.totalTokens ?? 100,
        percentage: overrides.percentage ?? 10,
        lastUpdated: overrides.lastUpdated || now,
        model: overrides.model || 'claude-sonnet-5',
        contextLimit: overrides.contextLimit ?? 200_000,
        firstMessage: overrides.firstMessage !== undefined ? overrides.firstMessage : 'hello world',
        sessionCreated: overrides.sessionCreated !== undefined ? overrides.sessionCreated : now,
        wasCleared: overrides.wasCleared ?? false,
    };
}

/** Default config with safe thresholds. */
const defaultConfig: StatusBarConfig = {
    warningThreshold: 50,
    dangerThreshold: 75,
    autoColor: true,
    baseColor: 'White',
    showEmoji: true,
    compactMode: false,
};

// ============================================================================
// MOCK VS CODE SURFACE
// ============================================================================

class MockThemeColor {
    constructor(public id: string) {}
}

class MockMarkdownString {
    constructor(public value: string, _supportHtml?: boolean) {}
}

class MockStatusBarItem implements VSCodeStatusBarItem {
    text = '';
    tooltip: { value: string } = { value: '' };
    color: string | undefined = undefined;
    backgroundColor: { id: string } | undefined = undefined;
    command: { command: string; title: string; arguments: string[] } | undefined = undefined;

    private _shown = false;
    private _disposed = false;

    show(): void { this._shown = true; }
    isShown(): boolean { return this._shown; }

    dispose(): void { this._disposed = true; }
    isDisposed(): boolean { return this._disposed; }
}

function makeMockVSCodeSurface(): {
    surface: VSCodeSurface;
    createdItems: MockStatusBarItem[];
} {
    const createdItems: MockStatusBarItem[] = [];
    const surface: VSCodeSurface = {
        createStatusBarItem(_alignment: number, _priority: number): VSCodeStatusBarItem {
            const item = new MockStatusBarItem();
            createdItems.push(item);
            return item;
        },
        ThemeColor: MockThemeColor as any,
        MarkdownString: MockMarkdownString as any,
        StatusBarAlignment: { Right: 2 },
    };
    return { surface, createdItems };
}

// ============================================================================
// PURE FUNCTION TESTS
// ============================================================================

describe('getEmojiForProject', () => {
    it('returns music emoji for music-related project', () => {
        assert.equal(getEmojiForProject('my-music-app'), '🎵');
        assert.equal(getEmojiForProject('ableton-project'), '🎵');
    });

    it('returns game emoji for game-related project', () => {
        assert.equal(getEmojiForProject('my-unity-game'), '🎮');
    });

    it('returns AI emoji for ML/data projects', () => {
        assert.equal(getEmojiForProject('ml-experiments'), '🤖');
        assert.equal(getEmojiForProject('neural-net'), '🤖');
    });

    it('returns web emoji for web projects', () => {
        assert.equal(getEmojiForProject('react-frontend'), '🌐');
    });

    it('returns brain emoji (default) for unrecognized project', () => {
        assert.equal(getEmojiForProject('zzzunknown'), '🧠');
    });

    it('is case-insensitive', () => {
        assert.equal(getEmojiForProject('MUSIC-APP'), '🎵');
    });

    it('matches keyword anywhere in name', () => {
        assert.equal(getEmojiForProject('super-game-engine'), '🎮');
    });
});

describe('extractLastSyllable', () => {
    it('extracts last syllable from typescript', () => {
        assert.equal(extractLastSyllable('typescript'), 'script');
    });

    it('extracts last syllable from webpack', () => {
        // Regex matches consonant cluster + vowel(s) + optional consonants at end.
        // "webpack" → "bpack" (bp=consonants, a=vowel, ck=consonants)
        assert.equal(extractLastSyllable('webpack'), 'bpack');
    });

    it('falls back to last few chars if no match', () => {
        // "abc" has no consonant-vowel-consonant pattern; regex won't match
        const result = extractLastSyllable('abc');
        assert.equal(result.length, 3);
        assert.equal(result, 'abc');
    });
});

describe('getShortName', () => {
    it('uses custom name override', () => {
        const custom: Record<string, string> = { 'my-cool-project': 'MCP' };
        assert.equal(getShortName('my-cool-project', custom), 'MCP');
    });

    it('creates acronym for multi-word project names', () => {
        assert.equal(getShortName('my-cool-project', {}), 'MCP');
    });

    it('abbreviates single-word names', () => {
        assert.equal(getShortName('typescript', {}), 'Tscript');
    });

    it('keeps short names (≤5 chars) unchanged', () => {
        assert.equal(getShortName('hello', {}), 'hello');
    });

    it('preserves session number suffix', () => {
        assert.equal(getShortName('my-project-2', {}), 'MP-2');
    });

    it('uses custom override for base name with session suffix', () => {
        const custom: Record<string, string> = { 'my-project': 'MP' };
        assert.equal(getShortName('my-project-2', custom), 'MP-2');
    });

    it('handles camelCase boundaries', () => {
        assert.equal(getShortName('myCoolProject', {}), 'MCP');
    });
});

describe('formatTokens', () => {
    it('formats millions', () => {
        assert.equal(formatTokens(1_500_000), '1.5M');
        assert.equal(formatTokens(1_000_000), '1.0M');
    });

    it('formats thousands', () => {
        assert.equal(formatTokens(1500), '2K');
        assert.equal(formatTokens(50000), '50K');
    });

    it('returns raw number for < 1000', () => {
        assert.equal(formatTokens(500), '500');
        assert.equal(formatTokens(0), '0');
    });
});

describe('buildSessionText', () => {
    it('formats with emoji and display name', () => {
        const s = makeSession({ projectName: 'my-project', percentage: 42 });
        const text = buildSessionText(s, defaultConfig, {});
        assert.ok(text.includes('42%'));
        assert.ok(text.includes('my-project'));
        // Emoji should be included by default
        assert.ok(text.length > 'my-project: 42%'.length);
    });

    it('omits emoji when showEmoji is false', () => {
        const s = makeSession({ projectName: 'my-project', percentage: 42 });
        const config = { ...defaultConfig, showEmoji: false };
        const text = buildSessionText(s, config, {});
        assert.equal(text, 'my-project: 42%');
    });

    it('uses short name in compact mode', () => {
        const s = makeSession({ projectName: 'my-cool-project', percentage: 42 });
        const config = { ...defaultConfig, compactMode: true };
        const text = buildSessionText(s, config, {});
        assert.ok(text.includes('MCP'));
        assert.ok(!text.includes('my-cool-project'));
    });

    it('uses full name when compactMode is off', () => {
        const s = makeSession({ projectName: 'my-cool-project', percentage: 42 });
        const text = buildSessionText(s, defaultConfig, {});
        assert.ok(text.includes('my-cool-project'));
    });
});

describe('getBackgroundColorId', () => {
    it('returns undefined below warning threshold', () => {
        assert.equal(getBackgroundColorId(30, 50, 75), undefined);
    });

    it('returns warning background at warning threshold', () => {
        assert.equal(getBackgroundColorId(50, 50, 75), 'statusBarItem.warningBackground');
    });

    it('returns warning background between thresholds', () => {
        assert.equal(getBackgroundColorId(60, 50, 75), 'statusBarItem.warningBackground');
    });

    it('returns error background at danger threshold', () => {
        assert.equal(getBackgroundColorId(75, 50, 75), 'statusBarItem.errorBackground');
    });

    it('returns error background above danger threshold', () => {
        assert.equal(getBackgroundColorId(90, 50, 75), 'statusBarItem.errorBackground');
    });
});

describe('buildTooltip', () => {
    it('includes project name and sessionId', () => {
        const s = makeSession({
            projectName: 'my-project',
            sessionId: 'abc12345',
            firstMessage: '',
        });
        const tooltip = buildTooltip(s);
        assert.ok(tooltip.includes('**my-project**'));
        assert.ok(tooltip.includes('abc12345'));
    });

    it('includes model name', () => {
        const s = makeSession({ projectName: 'test', model: 'claude-opus-4-8' });
        const tooltip = buildTooltip(s);
        assert.ok(tooltip.includes('claude-opus-4-8'));
    });

    it('includes first message when present', () => {
        const s = makeSession({ projectName: 'test', firstMessage: 'build an API...' });
        const tooltip = buildTooltip(s);
        assert.ok(tooltip.includes('build an API...'));
    });

    it('omits first message line when empty', () => {
        const s = makeSession({ projectName: 'test', firstMessage: '' });
        const tooltip = buildTooltip(s);
        assert.ok(!tooltip.includes('💬'));
    });

    it('includes token table', () => {
        const s = makeSession({
            projectName: 'test',
            totalTokens: 50000,
            cacheReadTokens: 20000,
            cacheCreationTokens: 5000,
            contextLimit: 200_000,
        });
        const tooltip = buildTooltip(s);
        assert.ok(tooltip.includes('| Cache Read | 20K |'));
        assert.ok(tooltip.includes('| Cache Creation | 5K |'));
        assert.ok(tooltip.includes('**50K** / 200K'));
    });

    it('includes last updated time', () => {
        const s = makeSession({ projectName: 'test' });
        const tooltip = buildTooltip(s);
        assert.ok(tooltip.includes('Last updated:'));
    });

    it('includes "Click to hide"', () => {
        const s = makeSession({ projectName: 'test' });
        const tooltip = buildTooltip(s);
        assert.ok(tooltip.includes('Click to hide'));
    });

    it('includes project path', () => {
        const s = makeSession({ projectName: 'test', projectPath: '/home/user/my-project' });
        const tooltip = buildTooltip(s);
        assert.ok(tooltip.includes('/home/user/my-project'));
    });

    it('shows context usage percentage', () => {
        const s = makeSession({ projectName: 'test', percentage: 75 });
        const tooltip = buildTooltip(s);
        assert.ok(tooltip.includes('75%'));
    });
});

describe('assignProjectColors', () => {
    it('assigns different colors to different projects in auto mode', () => {
        const s1 = makeSession({ projectName: 'alpha' });
        const s2 = makeSession({ projectName: 'beta' });
        const colors = assignProjectColors([s1, s2], defaultConfig);
        assert.equal(colors.size, 2);
        assert.notEqual(colors.get('alpha'), colors.get('beta'));
    });

    it('assigns same color to same project name', () => {
        const s1a = makeSession({ projectName: 'alpha', sessionId: 'a1', sessionFile: '/f/alpha/a1.jsonl' });
        const s1b = makeSession({ projectName: 'alpha', sessionId: 'a2', sessionFile: '/f/alpha/a2.jsonl' });
        const colors = assignProjectColors([s1a, s1b], defaultConfig);
        assert.equal(colors.size, 1);
    });

    it('uses base color variations when autoColor is false', () => {
        const s1 = makeSession({ projectName: 'alpha' });
        const s2 = makeSession({ projectName: 'beta' });
        const config = { ...defaultConfig, autoColor: false, baseColor: 'Blue' };
        const colors = assignProjectColors([s1, s2], config);
        assert.equal(colors.size, 2);
        // Both should be Blue variations
        for (const color of colors.values()) {
            assert.ok(color && color.length > 0);
        }
    });
});

describe('filterHiddenSessions', () => {
    it('returns all sessions when none are hidden', () => {
        const s1 = makeSession({ projectName: 'alpha', sessionFile: '/f/a.jsonl' });
        const s2 = makeSession({ projectName: 'beta', sessionFile: '/f/b.jsonl' });
        const hidden = new Map<string, number>();
        const result = filterHiddenSessions([s1, s2], hidden);
        assert.equal(result.length, 2);
    });

    it('filters out hidden sessions', () => {
        const s = makeSession({ projectName: 'alpha', sessionFile: '/f/a.jsonl' });
        const hidden = new Map<string, number>();
        hidden.set('/f/a.jsonl', Date.now() + 10000); // hidden in the future
        const result = filterHiddenSessions([s], hidden);
        assert.equal(result.length, 0);
    });

    it('auto-unhides session with new activity after hide', () => {
        const now = Date.now();
        const s = makeSession({
            projectName: 'alpha',
            sessionFile: '/f/a.jsonl',
            lastUpdated: new Date(now),
        });
        const hidden = new Map<string, number>();
        hidden.set('/f/a.jsonl', now - 10000); // hidden 10s ago, updated now
        const result = filterHiddenSessions([s], hidden);
        assert.equal(result.length, 1);
        // The session should be removed from hidden map
        assert.equal(hidden.has('/f/a.jsonl'), false);
    });

    it('keeps session hidden when no new activity', () => {
        const now = Date.now();
        const s = makeSession({
            projectName: 'alpha',
            sessionFile: '/f/a.jsonl',
            lastUpdated: new Date(now - 20000), // updated 20s ago
        });
        const hidden = new Map<string, number>();
        hidden.set('/f/a.jsonl', now - 10000); // hidden 10s ago (after last update)
        const result = filterHiddenSessions([s], hidden);
        assert.equal(result.length, 0);
    });
});

// ============================================================================
// StatusBarConfig TYPE TEST
// ============================================================================

describe('StatusBarConfig', () => {
    it('contains exactly 6 fields', () => {
        const config: StatusBarConfig = {
            warningThreshold: 50,
            dangerThreshold: 75,
            autoColor: true,
            baseColor: 'White',
            showEmoji: true,
            compactMode: false,
        };
        // Verify all 6 keys are present and no extras
        const keys = Object.keys(config);
        assert.equal(keys.length, 6);
        assert.ok(keys.includes('warningThreshold'));
        assert.ok(keys.includes('dangerThreshold'));
        assert.ok(keys.includes('autoColor'));
        assert.ok(keys.includes('baseColor'));
        assert.ok(keys.includes('showEmoji'));
        assert.ok(keys.includes('compactMode'));
    });
});

// ============================================================================
// StatusBarManager INTEGRATION TESTS
// ============================================================================

describe('StatusBarManager', () => {
    describe('updateSessions', () => {
        it('creates correct number of StatusBarItems for multiple projects', () => {
            const { surface, createdItems } = makeMockVSCodeSurface();
            const manager = new StatusBarManager(surface);
            const sessions = [
                makeSession({ projectName: 'alpha', sessionFile: '/f/a.jsonl' }),
                makeSession({ projectName: 'beta', sessionFile: '/f/b.jsonl' }),
                makeSession({ projectName: 'gamma', sessionFile: '/f/c.jsonl' }),
            ];

            manager.updateSessions(sessions, defaultConfig);

            assert.equal(createdItems.length, 3);
            const items = manager.getItems();
            assert.equal(items.length, 3);
        });

        it('creates zero items for empty sessions', () => {
            const { surface, createdItems } = makeMockVSCodeSurface();
            const manager = new StatusBarManager(surface);

            manager.updateSessions([], defaultConfig);

            assert.equal(createdItems.length, 0);
            assert.equal(manager.getItems().length, 0);
        });

        it('text format matches "{emoji} {displayName}: {percentage}%"', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new StatusBarManager(surface);
            const sessions = [
                makeSession({ projectName: 'my-project', percentage: 42, sessionFile: '/f/a.jsonl' }),
            ];

            manager.updateSessions(sessions, defaultConfig);

            const items = manager.getItems();
            assert.equal(items.length, 1);
            // Should contain emoji, space, project name, colon, space, percentage, %
            assert.ok(items[0].text.includes('my-project'));
            assert.ok(items[0].text.includes('42%'));
            // Check format: starts with emoji (non-ASCII) or space
            assert.ok(items[0].text.length > 'my-project: 42%'.length, 'should include emoji');
        });

        it('sets warning backgroundColor at warning threshold', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new StatusBarManager(surface);
            const sessions = [
                makeSession({ projectName: 'test', percentage: 55, sessionFile: '/f/a.jsonl' }),
            ];

            manager.updateSessions(sessions, defaultConfig);

            const items = manager.getItems();
            assert.equal(items.length, 1);
            assert.equal(items[0].backgroundColor, 'statusBarItem.warningBackground');
        });

        it('sets error backgroundColor at danger threshold', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new StatusBarManager(surface);
            const sessions = [
                makeSession({ projectName: 'test', percentage: 80, sessionFile: '/f/a.jsonl' }),
            ];

            manager.updateSessions(sessions, defaultConfig);

            const items = manager.getItems();
            assert.equal(items.length, 1);
            assert.equal(items[0].backgroundColor, 'statusBarItem.errorBackground');
        });

        it('sets no backgroundColor below warning threshold', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new StatusBarManager(surface);
            const sessions = [
                makeSession({ projectName: 'test', percentage: 30, sessionFile: '/f/a.jsonl' }),
            ];

            manager.updateSessions(sessions, defaultConfig);

            const items = manager.getItems();
            assert.equal(items.length, 1);
            assert.equal(items[0].backgroundColor, undefined);
        });

        it('compactMode uses short names', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new StatusBarManager(surface);
            const config = { ...defaultConfig, compactMode: true };
            const sessions = [
                makeSession({ projectName: 'my-cool-project', percentage: 10, sessionFile: '/f/a.jsonl' }),
            ];

            manager.updateSessions(sessions, config);

            const items = manager.getItems();
            assert.equal(items.length, 1);
            assert.ok(items[0].text.includes('MCP'), `expected short name MCP, got: ${items[0].text}`);
        });

        it('showEmoji false omits emoji', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new StatusBarManager(surface);
            const config = { ...defaultConfig, showEmoji: false };
            const sessions = [
                makeSession({ projectName: 'my-project', percentage: 10, sessionFile: '/f/a.jsonl' }),
            ];

            manager.updateSessions(sessions, config);

            const items = manager.getItems();
            assert.equal(items.length, 1);
            // Should not have emoji — the text starts with the project name
            assert.equal(items[0].text, 'my-project: 10%');
        });

        it('tooltip includes all required sections', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new StatusBarManager(surface);
            const sessions = [
                makeSession({
                    projectName: 'my-project',
                    sessionId: 'abc12345',
                    model: 'claude-opus-4-8',
                    totalTokens: 50000,
                    contextLimit: 200000,
                    firstMessage: 'build an API...',
                    sessionFile: '/f/a.jsonl',
                }),
            ];

            manager.updateSessions(sessions, defaultConfig);

            const items = manager.getItems();
            assert.equal(items.length, 1);
            const tooltip = items[0].tooltip;
            assert.ok(tooltip.includes('**my-project**'), 'should include project name');
            assert.ok(tooltip.includes('abc12345'), 'should include sessionId');
            assert.ok(tooltip.includes('claude-opus-4-8'), 'should include model');
            assert.ok(tooltip.includes('build an API...'), 'should include first message');
            assert.ok(tooltip.includes('Cache Read'), 'should include token table');
            assert.ok(tooltip.includes('Cache Creation'), 'should include token table');
            assert.ok(tooltip.includes('50K'), 'should include total tokens');
            assert.ok(tooltip.includes('Last updated:'), 'should include last updated');
            assert.ok(tooltip.includes('Click to hide'), 'should include click to hide');
        });

        it('disposes old items when sessions decrease', () => {
            const { surface, createdItems } = makeMockVSCodeSurface();
            const manager = new StatusBarManager(surface);

            const sessions = [
                makeSession({ projectName: 'alpha', sessionFile: '/f/a.jsonl' }),
                makeSession({ projectName: 'beta', sessionFile: '/f/b.jsonl' }),
            ];
            manager.updateSessions(sessions, defaultConfig);
            assert.equal(createdItems.length, 2);

            // Now reduce to one session
            const fewerSessions = [
                makeSession({ projectName: 'alpha', sessionFile: '/f/a.jsonl' }),
            ];
            manager.updateSessions(fewerSessions, defaultConfig);

            // One old item should be disposed
            const disposedItems = createdItems.filter(i => i.isDisposed());
            assert.equal(disposedItems.length, 1);
            assert.equal(manager.getItems().length, 1);
        });

        it('reuses existing items when session files match', () => {
            const { surface, createdItems } = makeMockVSCodeSurface();
            const manager = new StatusBarManager(surface);

            const sessions = [
                makeSession({ projectName: 'alpha', percentage: 10, sessionFile: '/f/a.jsonl' }),
            ];
            manager.updateSessions(sessions, defaultConfig);
            assert.equal(createdItems.length, 1);

            // Update same session with new percentage
            const updatedSessions = [
                makeSession({ projectName: 'alpha', percentage: 80, sessionFile: '/f/a.jsonl' }),
            ];
            manager.updateSessions(updatedSessions, defaultConfig);

            // Should still have only 1 item (reused), not 2
            assert.equal(createdItems.length, 1);
            assert.equal(manager.getItems().length, 1);
            assert.equal(manager.getItems()[0].backgroundColor, 'statusBarItem.errorBackground');
        });
    });

    describe('hideSession', () => {
        it('removes hidden session from items', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new StatusBarManager(surface);

            const sessions = [
                makeSession({ projectName: 'alpha', sessionFile: '/f/a.jsonl' }),
                makeSession({ projectName: 'beta', sessionFile: '/f/b.jsonl' }),
            ];
            manager.updateSessions(sessions, defaultConfig);
            assert.equal(manager.getItems().length, 2);

            manager.hideSession('/f/a.jsonl');

            const items = manager.getItems();
            assert.equal(items.length, 1);
            assert.equal(items[0].sessionFile, '/f/b.jsonl');
        });

        it('auto-unhides session when new activity detected', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new StatusBarManager(surface);

            const now = new Date();
            const session = makeSession({
                projectName: 'alpha',
                sessionFile: '/f/a.jsonl',
                lastUpdated: now,
            });

            manager.updateSessions([session], defaultConfig);
            assert.equal(manager.getItems().length, 1);

            // Hide it
            manager.hideSession('/f/a.jsonl');
            assert.equal(manager.getItems().length, 0);

            // New activity: session updated after hide
            const updatedSession = makeSession({
                projectName: 'alpha',
                sessionFile: '/f/a.jsonl',
                lastUpdated: new Date(Date.now() + 5000), // 5s after hide
            });
            manager.updateSessions([updatedSession], defaultConfig);

            // Should be visible again
            assert.equal(manager.getItems().length, 1);
        });
    });

    describe('top-5 truncation', () => {
        it('shows only 5 sessions when more exist', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new StatusBarManager(surface);

            const sessions = Array.from({ length: 8 }, (_, i) =>
                makeSession({
                    projectName: `project-${i}`,
                    sessionFile: `/f/p${i}.jsonl`,
                    lastUpdated: new Date(Date.now() - i * 1000), // descending freshness
                }),
            );

            manager.updateSessions(sessions, defaultConfig);

            assert.equal(manager.getItems().length, 5);
        });

        it('shows all sessions when 5 or fewer', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new StatusBarManager(surface);

            const sessions = Array.from({ length: 3 }, (_, i) =>
                makeSession({
                    projectName: `project-${i}`,
                    sessionFile: `/f/p${i}.jsonl`,
                }),
            );

            manager.updateSessions(sessions, defaultConfig);

            assert.equal(manager.getItems().length, 3);
        });
    });

    describe('dispose', () => {
        it('disposes all items and clears state', () => {
            const { surface, createdItems } = makeMockVSCodeSurface();
            const manager = new StatusBarManager(surface);

            const sessions = [
                makeSession({ projectName: 'alpha', sessionFile: '/f/a.jsonl' }),
                makeSession({ projectName: 'beta', sessionFile: '/f/b.jsonl' }),
            ];
            manager.updateSessions(sessions, defaultConfig);

            manager.dispose();

            // All items should be disposed
            for (const item of createdItems) {
                assert.ok(item.isDisposed(), 'all items should be disposed');
            }
            // getItems should return empty
            assert.equal(manager.getItems().length, 0);
        });

        it('clears hidden sessions on dispose', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new StatusBarManager(surface);

            manager.updateSessions(
                [makeSession({ projectName: 'test', sessionFile: '/f/a.jsonl' })],
                defaultConfig,
            );
            manager.hideSession('/f/a.jsonl');
            assert.equal(manager.getItems().length, 0);

            manager.dispose();

            // After dispose, if we re-add the same session it should be visible
            // (hiddenSessions is cleared)
            manager.updateSessions(
                [makeSession({ projectName: 'test', sessionFile: '/f/a.jsonl' })],
                defaultConfig,
            );
            // The old items are disposed; new items should be created
            assert.equal(manager.getItems().length, 1);
        });
    });

    describe('getItems', () => {
        it('returns correct sessionFile for each item', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new StatusBarManager(surface);

            const sessions = [
                makeSession({ projectName: 'alpha', sessionFile: '/f/alpha.jsonl' }),
                makeSession({ projectName: 'beta', sessionFile: '/f/beta.jsonl' }),
            ];
            manager.updateSessions(sessions, defaultConfig);

            const items = manager.getItems();
            const files = items.map(i => i.sessionFile).sort();
            assert.deepEqual(files, ['/f/alpha.jsonl', '/f/beta.jsonl']);
        });

        it('returns correct text for each item', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new StatusBarManager(surface);

            const sessions = [
                makeSession({ projectName: 'alpha', percentage: 30, sessionFile: '/f/a.jsonl' }),
            ];
            manager.updateSessions(sessions, defaultConfig);

            const items = manager.getItems();
            assert.equal(items.length, 1);
            assert.ok(items[0].text.includes('alpha'));
            assert.ok(items[0].text.includes('30%'));
        });

        it('returns correct color for each item', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new StatusBarManager(surface);

            const sessions = [
                makeSession({ projectName: 'alpha', sessionFile: '/f/a.jsonl' }),
            ];
            manager.updateSessions(sessions, defaultConfig);

            const items = manager.getItems();
            assert.equal(items.length, 1);
            // Color should be set from the palette
            assert.ok(items[0].color, 'color should be set');
            assert.ok(items[0].color!.startsWith('#'), 'color should be a hex code');
        });

        it('returns backgroundColor for items at threshold', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new StatusBarManager(surface);

            const sessions = [
                makeSession({ projectName: 'low', percentage: 10, sessionFile: '/f/low.jsonl' }),
                makeSession({ projectName: 'warn', percentage: 60, sessionFile: '/f/warn.jsonl' }),
                makeSession({ projectName: 'danger', percentage: 90, sessionFile: '/f/danger.jsonl' }),
            ];
            manager.updateSessions(sessions, defaultConfig);

            const items = manager.getItems();
            const byFile = new Map(items.map(i => [i.sessionFile, i]));

            assert.equal(byFile.get('/f/low.jsonl')!.backgroundColor, undefined);
            assert.equal(byFile.get('/f/warn.jsonl')!.backgroundColor, 'statusBarItem.warningBackground');
            assert.equal(byFile.get('/f/danger.jsonl')!.backgroundColor, 'statusBarItem.errorBackground');
        });
    });

    describe('color assignment per project', () => {
        it('assigns a color from the palette to every session item', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new StatusBarManager(surface);

            const sessions = [
                makeSession({ projectName: 'myproject', sessionFile: '/f/a.jsonl', sessionId: 'a' }),
                makeSession({ projectName: 'myproject-2', sessionFile: '/f/b.jsonl', sessionId: 'b' }),
            ];
            manager.updateSessions(sessions, defaultConfig);

            const items = manager.getItems();
            assert.equal(items.length, 2);
            // Every item should receive a color (hex from palette or base-color variations)
            for (const item of items) {
                assert.ok(item.color, 'each item should have a color');
                assert.ok(item.color!.startsWith('#'), 'color should be a hex code');
            }
        });
    });
});
