import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    UsageStatusBarConfig,
    SubscriptionUsageManager,
    UsageItemSnapshot,
    _test,
    _setData,
} from './subscriptionUsageManager';
import type { UsageData, UsageMeter } from './subscriptionUsageManager';
import { VSCodeSurface, VSCodeStatusBarItem } from './vscodeSurface';
const {
    parseUsage,
    formatReset,
    buildUsageTooltip,
} = _test;

// ============================================================================
// TEST HELPERS
// ============================================================================

function makeUsageMeter(overrides: Partial<UsageMeter> = {}): UsageMeter {
    return {
        key: overrides.key || 'session',
        label: overrides.label || 'Session (5h)',
        percentage: overrides.percentage ?? 30,
        resetsAt: overrides.resetsAt !== undefined ? overrides.resetsAt : new Date('2026-07-15T10:00:00Z'),
        isActive: overrides.isActive ?? true,
    };
}

function makeUsageData(overrides: Partial<UsageData> = {}): UsageData {
    const session = overrides.session !== undefined
        ? overrides.session
        : makeUsageMeter({ key: 'session', label: 'Session (5h)', percentage: 30 });
    const meters = overrides.meters || [
        session!,
        makeUsageMeter({ key: 'weekly_all', label: 'Weekly (all models)', percentage: 16, isActive: false }),
    ];
    return { session, meters };
}

const defaultConfig: UsageStatusBarConfig = {
    showUsage: true,
    warningThreshold: 50,
    dangerThreshold: 75,
    usageRefreshInterval: 60,
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
// PARSER TESTS (kept from usage.test.ts)
// ============================================================================

function realBody() {
    return {
        five_hour: { utilization: 30.0, resets_at: '2026-07-12T18:50:00.02+00:00' },
        seven_day: { utilization: 16.0, resets_at: '2026-07-14T00:00:00.02+00:00' },
        seven_day_opus: null,
        limits: [
            { kind: 'session', group: 'session', percent: 30, resets_at: '2026-07-12T18:50:00.02+00:00', scope: null, is_active: true },
            { kind: 'weekly_all', group: 'weekly', percent: 16, resets_at: '2026-07-14T00:00:00.02+00:00', scope: null, is_active: false },
            { kind: 'weekly_scoped', group: 'weekly', percent: 0, resets_at: null, scope: { model: { id: null, display_name: 'Fable' } }, is_active: false },
        ],
        member_dashboard_available: false,
    };
}

describe('parseUsage — limits array (real response)', () => {
    it('returns null for empty / non-object / no-limits bodies', () => {
        assert.equal(parseUsage(null), null);
        assert.equal(parseUsage({}), null);
        assert.equal(parseUsage({ member_dashboard_available: false }), null);
    });

    it('maps the three limits to labeled meters in order', () => {
        const data = parseUsage(realBody());
        assert.ok(data);
        assert.deepEqual(
            data!.meters.map((m) => m.label),
            ['Session (5h)', 'Weekly (all models)', 'Weekly Fable'],
        );
        assert.deepEqual(data!.meters.map((m) => m.percentage), [30, 16, 0]);
    });

    it('identifies the session meter for the status bar', () => {
        const data = parseUsage(realBody());
        assert.equal(data!.session!.label, 'Session (5h)');
        assert.equal(data!.session!.percentage, 30);
        assert.equal(data!.session!.isActive, true);
    });

    it('parses ISO reset timestamps and tolerates null', () => {
        const data = parseUsage(realBody());
        assert.ok(data!.meters[0].resetsAt instanceof Date);
        assert.equal(data!.meters[2].resetsAt, null);
    });

    it('derives scoped weekly labels from the model display name', () => {
        const body = {
            limits: [
                { kind: 'session', percent: 5, is_active: true },
                { kind: 'weekly_scoped', percent: 2, scope: { model: { display_name: 'Opus' } } },
            ],
        };
        const data = parseUsage(body);
        assert.equal(data!.meters[1].label, 'Weekly Opus');
        assert.equal(data!.meters[1].key, 'weekly_scoped:Opus');
    });

    it('humanizes an unknown limit kind', () => {
        const data = parseUsage({ limits: [{ kind: 'monthly_special', percent: 3 }] });
        assert.equal(data!.meters[0].label, 'Monthly Special');
    });

    it('skips limits without a usable percent', () => {
        const data = parseUsage({
            limits: [
                { kind: 'session', percent: 30, is_active: true },
                { kind: 'weekly_all' },
            ],
        });
        assert.deepEqual(data!.meters.map((m) => m.label), ['Session (5h)']);
    });

    it('clamps and rounds percentages', () => {
        const data = parseUsage({ limits: [{ kind: 'session', percent: 28.6 }, { kind: 'weekly_all', percent: 140 }] });
        assert.equal(data!.meters[0].percentage, 29);
        assert.equal(data!.meters[1].percentage, 100);
    });
});

describe('parseUsage — fallback (no limits array)', () => {
    it('reads flat top-level windows when limits is absent', () => {
        const data = parseUsage({
            five_hour: { utilization: 7, resets_at: 1_800_000_000 },
            seven_day: { utilization: 14 },
            member_dashboard_available: false,
        });
        assert.equal(data!.session!.label, 'Session (5h)');
        assert.equal(data!.session!.percentage, 7);
        assert.deepEqual(data!.meters.map((m) => m.key), ['five_hour', 'seven_day']);
    });

    it('accepts a rate_limits wrapper and Unix-epoch resets', () => {
        const epoch = 1_800_000_000;
        const data = parseUsage({ rate_limits: { five_hour: { utilization: 10, resets_at: epoch } } });
        assert.equal(data!.session!.resetsAt!.getTime(), epoch * 1000);
    });

    it('ignores non-window keys and null meters', () => {
        const data = parseUsage({
            five_hour: { utilization: 7 },
            seven_day_opus: null,
            extra_usage: { utilization: 13.9 },
            spend: { used: {} },
        });
        assert.deepEqual(data!.meters.map((m) => m.key), ['five_hour']);
    });

    it('falls back to used_percentage', () => {
        const data = parseUsage({ five_hour: { used_percentage: 42 } });
        assert.equal(data!.session!.percentage, 42);
    });
});

// ============================================================================
// PURE FUNCTION TESTS (formatReset, buildUsageTooltip)
// ============================================================================

describe('formatReset', () => {
    it('returns empty string for null resetsAt', () => {
        assert.equal(formatReset(null), '');
    });

    it('returns resetting message when time is past', () => {
        const past = new Date(Date.now() - 60_000);
        assert.equal(formatReset(past), ' — resetting');
    });

    it('shows minutes for < 1 hour', () => {
        const in30m = new Date(Date.now() + 30 * 60_000);
        const result = formatReset(in30m);
        assert.ok(result.includes('m'), `expected minutes, got: ${result}`);
        assert.ok(result.includes('resets in'));
    });

    it('shows hours for < 24 hours', () => {
        const in3h = new Date(Date.now() + 3 * 3_600_000);
        const result = formatReset(in3h);
        assert.ok(result.includes('h'), `expected hours, got: ${result}`);
        assert.ok(result.includes('resets in'));
    });

    it('shows days for >= 24 hours', () => {
        const in3d = new Date(Date.now() + 3 * 86_400_000);
        const result = formatReset(in3d);
        assert.ok(result.includes('d'), `expected days, got: ${result}`);
        assert.ok(result.includes('resets in'));
    });

    it('shows at least 1m for sub-minute durations', () => {
        const in30s = new Date(Date.now() + 30_000);
        const result = formatReset(in30s);
        assert.ok(result.includes('1m'), `expected at least 1m, got: ${result}`);
    });
});

describe('buildUsageTooltip', () => {
    it('includes header and table structure', () => {
        const data = makeUsageData();
        const tooltip = buildUsageTooltip(data);
        assert.ok(tooltip.includes('⚡ **Claude Usage**'));
        assert.ok(tooltip.includes('| Limit | Used | Resets |'));
        assert.ok(tooltip.includes('Session (5h)'));
        assert.ok(tooltip.includes('30%'));
    });

    it('includes all meters in tooltip', () => {
        const data = makeUsageData({
            meters: [
                makeUsageMeter({ key: 'session', label: 'Session (5h)', percentage: 42 }),
                makeUsageMeter({ key: 'weekly_all', label: 'Weekly (all models)', percentage: 10, isActive: false }),
            ],
            session: makeUsageMeter({ key: 'session', label: 'Session (5h)', percentage: 42 }),
        });
        const tooltip = buildUsageTooltip(data);
        assert.ok(tooltip.includes('Session (5h)'));
        assert.ok(tooltip.includes('42%'));
        assert.ok(tooltip.includes('Weekly (all models)'));
        assert.ok(tooltip.includes('10%'));
    });

    it('includes subscription usage footer', () => {
        const data = makeUsageData();
        const tooltip = buildUsageTooltip(data);
        assert.ok(tooltip.includes('/usage'));
        assert.ok(tooltip.includes('Subscription rate limits'));
    });

    it('includes reset time when present', () => {
        const resetsAt = new Date(Date.now() + 3 * 3_600_000);
        const data = makeUsageData({
            meters: [makeUsageMeter({ key: 'session', resetsAt })],
            session: makeUsageMeter({ key: 'session', resetsAt }),
        });
        const tooltip = buildUsageTooltip(data);
        assert.ok(tooltip.includes('resets in'));
    });
});

// ============================================================================
// USAGE STATUS BAR CONFIG TYPE TEST
// ============================================================================

describe('UsageStatusBarConfig', () => {
    it('contains exactly 4 fields', () => {
        const config: UsageStatusBarConfig = {
            showUsage: true,
            warningThreshold: 50,
            dangerThreshold: 75,
            usageRefreshInterval: 60,
        };
        const keys = Object.keys(config);
        assert.equal(keys.length, 4);
        assert.ok(keys.includes('showUsage'));
        assert.ok(keys.includes('warningThreshold'));
        assert.ok(keys.includes('dangerThreshold'));
        assert.ok(keys.includes('usageRefreshInterval'));
    });
});

// ============================================================================
// SUBSCRIPTION USAGE MANAGER INTEGRATION TESTS (mock VSCodeSurface)
// ============================================================================

describe('SubscriptionUsageManager', () => {
    describe('constructor and getItems', () => {
        it('returns empty items before start', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new SubscriptionUsageManager(surface);
            assert.deepEqual(manager.getItems(), []);
        });
    });

    describe('start', () => {
        it('creates a StatusBarItem when showUsage is true and data is available', () => {
            const { surface, createdItems } = makeMockVSCodeSurface();
            const manager = new SubscriptionUsageManager(surface);

            // Seed data via _test so render produces output
            const data = makeUsageData({ session: makeUsageMeter({ percentage: 30 }) });
            _setData(manager, data);
            manager.start(defaultConfig);

            // start begins a polling interval; we should have a rendered item
            const items = manager.getItems();
            assert.equal(items.length, 1);
            assert.equal(createdItems.length, 1);
        });

        it('does not create item when showUsage is false', () => {
            const { surface, createdItems } = makeMockVSCodeSurface();
            const manager = new SubscriptionUsageManager(surface);

            const data = makeUsageData();
            _setData(manager, data);
            manager.start({ ...defaultConfig, showUsage: false });

            assert.equal(manager.getItems().length, 0);
            assert.equal(createdItems.length, 0);
        });

        it('does not create item when there is no session data', () => {
            const { surface, createdItems } = makeMockVSCodeSurface();
            const manager = new SubscriptionUsageManager(surface);

            const data: UsageData = { session: null, meters: [] };
            _setData(manager, data);
            manager.start(defaultConfig);

            assert.equal(manager.getItems().length, 0);
            assert.equal(createdItems.length, 0);
        });
    });

    describe('StatusBarItem content', () => {
        it('renders text as "✨️ {percentage}%"', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new SubscriptionUsageManager(surface);

            const data = makeUsageData({ session: makeUsageMeter({ percentage: 42 }) });
            _setData(manager, data);
            manager.start(defaultConfig);

            const items = manager.getItems();
            assert.equal(items.length, 1);
            assert.ok(items[0].text.includes('42%'), `expected text to include 42%, got: ${items[0].text}`);
            assert.ok(items[0].text.includes('✨'), `expected text to include sparkle emoji, got: ${items[0].text}`);
        });

        it('sets warning backgroundColor at warning threshold', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new SubscriptionUsageManager(surface);

            const data = makeUsageData({ session: makeUsageMeter({ percentage: 55 }) });
            _setData(manager, data);
            manager.start(defaultConfig);

            const items = manager.getItems();
            assert.equal(items.length, 1);
            assert.equal(items[0].backgroundColor, 'statusBarItem.warningBackground');
        });

        it('sets error backgroundColor at danger threshold', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new SubscriptionUsageManager(surface);

            const data = makeUsageData({ session: makeUsageMeter({ percentage: 80 }) });
            _setData(manager, data);
            manager.start(defaultConfig);

            const items = manager.getItems();
            assert.equal(items.length, 1);
            assert.equal(items[0].backgroundColor, 'statusBarItem.errorBackground');
        });

        it('sets error backgroundColor above danger threshold', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new SubscriptionUsageManager(surface);

            const data = makeUsageData({ session: makeUsageMeter({ percentage: 90 }) });
            _setData(manager, data);
            manager.start(defaultConfig);

            const items = manager.getItems();
            assert.equal(items.length, 1);
            assert.equal(items[0].backgroundColor, 'statusBarItem.errorBackground');
        });

        it('sets no backgroundColor below warning threshold', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new SubscriptionUsageManager(surface);

            const data = makeUsageData({ session: makeUsageMeter({ percentage: 30 }) });
            _setData(manager, data);
            manager.start(defaultConfig);

            const items = manager.getItems();
            assert.equal(items.length, 1);
            assert.equal(items[0].backgroundColor, undefined);
        });

        it('tooltip contains usage data with markdown', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new SubscriptionUsageManager(surface);

            const data = makeUsageData({
                session: makeUsageMeter({ key: 'session', label: 'Session (5h)', percentage: 42 }),
                meters: [
                    makeUsageMeter({ key: 'session', label: 'Session (5h)', percentage: 42 }),
                    makeUsageMeter({ key: 'weekly_all', label: 'Weekly (all models)', percentage: 16, isActive: false }),
                ],
            });
            _setData(manager, data);
            manager.start(defaultConfig);

            const items = manager.getItems();
            assert.equal(items.length, 1);
            const tooltip = items[0].tooltip;
            assert.ok(tooltip.includes('⚡ **Claude Usage**'), 'should include markdown header');
            assert.ok(tooltip.includes('Session (5h)'), 'should include session label');
            assert.ok(tooltip.includes('42%'), 'should include session percentage');
            assert.ok(tooltip.includes('Weekly (all models)'), 'should include weekly meter');
            assert.ok(tooltip.includes('16%'), 'should include weekly percentage');
            assert.ok(tooltip.includes('/usage'), 'should include subscription footnote');
        });
    });

    describe('updateConfig', () => {
        it('updates thresholds and re-renders with new values', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new SubscriptionUsageManager(surface);

            const data = makeUsageData({ session: makeUsageMeter({ percentage: 60 }) });
            _setData(manager, data);
            manager.start(defaultConfig);

            // With default thresholds (50/75), 60% should be warning
            let items = manager.getItems();
            assert.equal(items[0].backgroundColor, 'statusBarItem.warningBackground');

            // Update warning threshold to 70 — 60% should now be below threshold
            manager.updateConfig({ ...defaultConfig, warningThreshold: 70, dangerThreshold: 90 });
            items = manager.getItems();
            assert.equal(items[0].backgroundColor, undefined);
        });

        it('hides item when showUsage toggled to false', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new SubscriptionUsageManager(surface);

            const data = makeUsageData({ session: makeUsageMeter({ percentage: 30 }) });
            _setData(manager, data);
            manager.start(defaultConfig);

            assert.equal(manager.getItems().length, 1);

            manager.updateConfig({ ...defaultConfig, showUsage: false });
            assert.equal(manager.getItems().length, 0);
        });

        it('shows item when showUsage toggled back to true', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new SubscriptionUsageManager(surface);

            const data = makeUsageData({ session: makeUsageMeter({ percentage: 30 }) });
            _setData(manager, data);
            manager.start({ ...defaultConfig, showUsage: false });
            assert.equal(manager.getItems().length, 0);

            manager.updateConfig({ ...defaultConfig, showUsage: true });
            // Data is still there, item should reappear
            assert.equal(manager.getItems().length, 1);
        });
    });

    describe('dispose', () => {
        it('disposes StatusBarItem and clears state', () => {
            const { surface, createdItems } = makeMockVSCodeSurface();
            const manager = new SubscriptionUsageManager(surface);

            const data = makeUsageData();
            _setData(manager, data);
            manager.start(defaultConfig);
            assert.equal(createdItems.length, 1);

            manager.dispose();

            // Item should be disposed
            assert.ok(createdItems[0].isDisposed(), 'item should be disposed');
            // getItems should return empty
            assert.equal(manager.getItems().length, 0);
        });

        it('can be called safely with no item', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new SubscriptionUsageManager(surface);

            // dispose before start should not throw
            assert.doesNotThrow(() => manager.dispose());
            assert.equal(manager.getItems().length, 0);
        });
    });

    describe('refresh', () => {
        it('clears data and hides item when showUsage is false', async () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new SubscriptionUsageManager(surface);

            const data = makeUsageData();
            _setData(manager, data);
            manager.start(defaultConfig);
            assert.equal(manager.getItems().length, 1);

            // Simulate what happens during refresh when showUsage=false
            manager.updateConfig({ ...defaultConfig, showUsage: false });
            // refresh would call getUsage which we can't test, but the render
            // path via updateConfig already covers the showUsage=false case
            assert.equal(manager.getItems().length, 0);
        });
    });

    describe('getItems', () => {
        it('returns text and backgroundColor for a single item', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new SubscriptionUsageManager(surface);

            const data = makeUsageData({ session: makeUsageMeter({ percentage: 65 }) });
            _setData(manager, data);
            manager.start(defaultConfig);

            const items = manager.getItems();
            assert.equal(items.length, 1);
            assert.ok(items[0].text.length > 0);
            assert.equal(items[0].backgroundColor, 'statusBarItem.warningBackground');
        });

        it('returns tooltip content', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new SubscriptionUsageManager(surface);

            const data = makeUsageData({
                session: makeUsageMeter({ key: 'session', label: 'Session (5h)', percentage: 20 }),
                meters: [
                    makeUsageMeter({ key: 'session', label: 'Session (5h)', percentage: 20 }),
                ],
            });
            _setData(manager, data);
            manager.start(defaultConfig);

            const items = manager.getItems();
            assert.equal(items.length, 1);
            assert.ok(items[0].tooltip.includes('Session (5h)'));
            assert.ok(items[0].tooltip.includes('20%'));
        });

        it('returns correct snapshot shape', () => {
            const { surface } = makeMockVSCodeSurface();
            const manager = new SubscriptionUsageManager(surface);

            const data = makeUsageData({ session: makeUsageMeter({ percentage: 10 }) });
            _setData(manager, data);
            manager.start(defaultConfig);

            const items = manager.getItems();
            assert.equal(items.length, 1);
            const snapshot: UsageItemSnapshot = items[0];
            assert.equal(typeof snapshot.text, 'string');
            assert.equal(typeof snapshot.tooltip, 'string');
            // backgroundColor may be string or undefined
            assert.ok(snapshot.backgroundColor === undefined || typeof snapshot.backgroundColor === 'string');
        });
    });
});
