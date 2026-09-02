import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import {
    expandHome,
    resolveClaudeConfigDir,
    claudeProjectsDir,
    isDefaultClaudeConfigDir,
    hasExplicitConfigDir,
} from './configDir';

describe('expandHome', () => {
    const home = path.join('C:', 'Users', 'me');

    it('expands a bare tilde', () => {
        assert.equal(expandHome('~', home), home);
    });

    it('expands ~/relative', () => {
        assert.equal(expandHome('~/.claude-pro', home), path.join(home, '.claude-pro'));
    });

    it('leaves absolute paths unchanged', () => {
        const abs = path.join(home, '.claude-work');
        assert.equal(expandHome(abs, home), abs);
    });
});

describe('resolveClaudeConfigDir', () => {
    const home = path.join('C:', 'Users', 'me');
    const defaultDir = path.join(home, '.claude');

    it('uses the VS Code setting over the env var', () => {
        assert.equal(
            resolveClaudeConfigDir({
                setting: '~/.claude-pro',
                env: { CLAUDE_CONFIG_DIR: path.join(home, '.claude-work') },
                homedir: home,
            }),
            path.join(home, '.claude-pro'),
        );
    });

    it('uses CLAUDE_CONFIG_DIR when the setting is empty', () => {
        assert.equal(
            resolveClaudeConfigDir({
                setting: '  ',
                env: { CLAUDE_CONFIG_DIR: path.join(home, '.claude-work') },
                homedir: home,
            }),
            path.join(home, '.claude-work'),
        );
    });

    it('falls back to ~/.claude', () => {
        assert.equal(
            resolveClaudeConfigDir({ setting: '', env: {}, homedir: home }),
            defaultDir,
        );
    });

    it('trims the setting', () => {
        assert.equal(
            resolveClaudeConfigDir({
                setting: '  ~/.claude-pro  ',
                env: {},
                homedir: home,
            }),
            path.join(home, '.claude-pro'),
        );
    });
});

describe('claudeProjectsDir', () => {
    it('appends projects/', () => {
        const config = path.join('C:', 'Users', 'me', '.claude-pro');
        assert.equal(claudeProjectsDir(config), path.join(config, 'projects'));
    });
});

describe('isDefaultClaudeConfigDir', () => {
    const home = path.join('C:', 'Users', 'me');

    it('treats ~/.claude as default', () => {
        assert.equal(isDefaultClaudeConfigDir(path.join(home, '.claude'), home), true);
    });

    it('treats a relocated dir as non-default', () => {
        assert.equal(isDefaultClaudeConfigDir(path.join(home, '.claude-pro'), home), false);
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
