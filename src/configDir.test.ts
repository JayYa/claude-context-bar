import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    expandHome,
    resolveClaudeConfigDir,
    claudeProjectsDir,
    isDefaultClaudeConfigDir,
    hasExplicitConfigDir,
} from './configDir';

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
