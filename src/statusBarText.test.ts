import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    truncateLabel,
    formatTokens,
    formatStatusBarText,
    disambiguateNames,
    resolveDisplayName,
    STATUS_BAR_NAME_MAX,
} from './statusBarText';

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

describe('formatTokens', () => {
    it('formats thousands and millions', () => {
        assert.equal(formatTokens(185_000), '185K');
        assert.equal(formatTokens(1_200_000), '1.2M');
        assert.equal(formatTokens(42), '42');
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
