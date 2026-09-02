import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsage } from './usage';
import {
    expandHome,
    resolveClaudeConfigDir,
    claudeProjectsDir,
    isDefaultClaudeConfigDir,
    hasExplicitConfigDir,
} from './configDir';
import {
    readTitleFromEntry,
    pickSessionTitle,
    truncateLabel,
    formatTokens,
    formatUsageValue,
    formatStatusBarText,
    disambiguateNames,
    resolveDisplayName,
    STATUS_BAR_NAME_MAX,
} from './statusBarText';

// A response shaped like the real GET /api/oauth/usage body, trimmed to the
// fields the parser reads.
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
        // Scoped meters get distinct keys so multiple models don't collide.
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

describe('expandHome', () => {
    const home = 'C:\\Users\\me';

    it('expands a bare tilde', () => {
        assert.equal(expandHome('~', home), home);
    });

    it('expands ~/relative', () => {
        assert.equal(expandHome('~/.claude-pro', home), 'C:\\Users\\me\\.claude-pro');
    });

    it('leaves absolute paths unchanged', () => {
        assert.equal(expandHome('C:\\Users\\me\\.claude-work', home), 'C:\\Users\\me\\.claude-work');
    });
});

describe('resolveClaudeConfigDir', () => {
    const home = 'C:\\Users\\me';

    it('uses the VS Code setting over the env var', () => {
        assert.equal(
            resolveClaudeConfigDir({
                setting: '~/.claude-pro',
                env: { CLAUDE_CONFIG_DIR: 'C:\\Users\\me\\.claude-work' },
                homedir: home,
            }),
            'C:\\Users\\me\\.claude-pro',
        );
    });

    it('uses CLAUDE_CONFIG_DIR when the setting is empty', () => {
        assert.equal(
            resolveClaudeConfigDir({
                setting: '  ',
                env: { CLAUDE_CONFIG_DIR: 'C:\\Users\\me\\.claude-work' },
                homedir: home,
            }),
            'C:\\Users\\me\\.claude-work',
        );
    });

    it('falls back to ~/.claude', () => {
        assert.equal(
            resolveClaudeConfigDir({ setting: '', env: {}, homedir: home }),
            'C:\\Users\\me\\.claude',
        );
    });

    it('trims the setting', () => {
        assert.equal(
            resolveClaudeConfigDir({
                setting: '  ~/.claude-pro  ',
                env: {},
                homedir: home,
            }),
            'C:\\Users\\me\\.claude-pro',
        );
    });
});

describe('claudeProjectsDir', () => {
    it('appends projects/', () => {
        assert.equal(claudeProjectsDir('C:\\Users\\me\\.claude-pro'), 'C:\\Users\\me\\.claude-pro\\projects');
    });
});

describe('isDefaultClaudeConfigDir', () => {
    const home = 'C:\\Users\\me';

    it('treats ~/.claude as default', () => {
        assert.equal(isDefaultClaudeConfigDir('C:\\Users\\me\\.claude', home), true);
    });

    it('treats a relocated dir as non-default', () => {
        assert.equal(isDefaultClaudeConfigDir('C:\\Users\\me\\.claude-pro', home), false);
    });
});

describe('hasExplicitConfigDir', () => {
    it('is false when neither setting nor env is set', () => {
        assert.equal(hasExplicitConfigDir('', {}), false);
        assert.equal(hasExplicitConfigDir('  ', {}), false);
    });

    it('is true when the setting is set', () => {
        assert.equal(hasExplicitConfigDir('C:\\Users\\me\\.claude-pro', {}), true);
    });

    it('is true when CLAUDE_CONFIG_DIR is set', () => {
        assert.equal(hasExplicitConfigDir('', { CLAUDE_CONFIG_DIR: 'C:\\Users\\me\\.claude-pro' }), true);
    });
});

describe('readTitleFromEntry', () => {
    it('reads custom-title.customTitle', () => {
        assert.deepEqual(
            readTitleFromEntry({ type: 'custom-title', customTitle: 'auth-refactor' }),
            { customTitle: 'auth-refactor' },
        );
    });

    it('falls back to title/name on custom-title entries', () => {
        assert.deepEqual(
            readTitleFromEntry({ type: 'custom-title', title: 'plan-name' }),
            { customTitle: 'plan-name' },
        );
        assert.deepEqual(
            readTitleFromEntry({ type: 'custom-title', name: 'flag-name' }),
            { customTitle: 'flag-name' },
        );
    });

    it('reads ai-title.aiTitle', () => {
        assert.deepEqual(
            readTitleFromEntry({ type: 'ai-title', aiTitle: 'Research 480p AI video upscaling' }),
            { aiTitle: 'Research 480p AI video upscaling' },
        );
    });

    it('ignores other entry types', () => {
        assert.deepEqual(readTitleFromEntry({ type: 'user', message: {} }), {});
        assert.deepEqual(readTitleFromEntry({ type: 'agent-name', agentName: 'x' }), {});
        assert.deepEqual(readTitleFromEntry(null), {});
    });
});

describe('pickSessionTitle', () => {
    it('prefers a custom title over a generated one', () => {
        assert.equal(pickSessionTitle('auth-refactor', 'Fix login timeout'), 'auth-refactor');
    });

    it('uses the generated title when no custom title is set', () => {
        assert.equal(pickSessionTitle('', 'Fix login timeout'), 'Fix login timeout');
        assert.equal(pickSessionTitle('  ', 'Fix login timeout'), 'Fix login timeout');
    });

    it('returns empty when neither is set', () => {
        assert.equal(pickSessionTitle('', ''), '');
    });
});

describe('truncateLabel', () => {
    it('leaves short names unchanged', () => {
        assert.equal(truncateLabel('Fix auth expiry'), 'Fix auth expiry');
    });

    it(`truncates to at most ${STATUS_BAR_NAME_MAX} chars with an ellipsis`, () => {
        const long = 'Research 480p AI video upscaling';
        const out = truncateLabel(long);
        assert.ok(out.length <= STATUS_BAR_NAME_MAX);
        assert.ok(out.endsWith('…'));
        assert.equal(out, 'Research 480p AI video…');
    });
});

describe('formatTokens / formatUsageValue', () => {
    it('formats thousands and millions', () => {
        assert.equal(formatTokens(185_000), '185K');
        assert.equal(formatTokens(1_200_000), '1.2M');
        assert.equal(formatTokens(42), '42');
    });

    it('switches between percent and tokens', () => {
        assert.equal(formatUsageValue(18, 185_000, 'percent'), '18%');
        assert.equal(formatUsageValue(18, 185_000, 'tokens'), '185K');
    });
});

describe('formatStatusBarText', () => {
    it('includes the emoji when present', () => {
        assert.equal(formatStatusBarText('🔧', 'claude-context-bar', '18%'), '🔧 claude-context-bar: 18%');
    });

    it('omits the extra space when emoji is off', () => {
        assert.equal(formatStatusBarText('', 'claude-context-bar', '185K'), 'claude-context-bar: 185K');
    });
});

describe('disambiguateNames', () => {
    it('leaves unique names alone', () => {
        assert.deepEqual(disambiguateNames(['Fix auth', 'Debug X']), ['Fix auth', 'Debug X']);
    });

    it('suffixes later duplicates with -2, -3', () => {
        assert.deepEqual(
            disambiguateNames(['Same', 'Other', 'Same', 'Same']),
            ['Same', 'Other', 'Same-2', 'Same-3'],
        );
    });
});

describe('resolveDisplayName', () => {
    it('uses the numbered project name in project mode', () => {
        assert.equal(
            resolveDisplayName({
                label: 'project',
                projectName: 'webapp-2',
                baseProjectName: 'webapp',
                sessionTitle: 'Fix auth expiry',
                compactProjectName: 'webapp-2',
            }),
            'webapp-2',
        );
    });

    it('uses compact names in project mode', () => {
        assert.equal(
            resolveDisplayName({
                label: 'project',
                projectName: 'my-cool-project',
                baseProjectName: 'my-cool-project',
                sessionTitle: '',
                compactProjectName: 'MCP',
            }),
            'MCP',
        );
    });

    it('uses the session title in session mode, truncated', () => {
        assert.equal(
            resolveDisplayName({
                label: 'session',
                projectName: 'webapp-2',
                baseProjectName: 'webapp',
                sessionTitle: 'Research 480p AI video upscaling',
                compactProjectName: 'webapp-2',
            }),
            'Research 480p AI video…',
        );
    });

    it('falls back to the base project name when no title exists yet', () => {
        assert.equal(
            resolveDisplayName({
                label: 'session',
                projectName: 'webapp-2',
                baseProjectName: 'webapp',
                sessionTitle: '',
                compactProjectName: 'WA-2',
            }),
            'webapp',
        );
    });
});
