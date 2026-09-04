import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decodeProjectPath } from './projectPath';

// --- fixtures ---------------------------------------------------------------
//
// The input is a single string, so there is nothing to build: cases spell out
// the encoded directory name Claude Code would have written for a given path,
// which is the fixture and the documentation at once.

function name(encoded: string): string {
    return decodeProjectPath(encoded).name;
}

function fullPath(encoded: string): string {
    return decodeProjectPath(encoded).fullPath;
}

// --- tests ------------------------------------------------------------------

describe('decodeProjectPath — Windows paths', () => {
    it('reads the doubled dash as the drive colon', () => {
        assert.equal(fullPath('C--dev-webapp'), 'C:\\dev\\webapp');
    });

    it('upper-cases a lower-case drive letter', () => {
        assert.equal(fullPath('c--dev-webapp'), 'C:\\dev\\webapp');
    });

    it('names the project after the folder, not the drive or its parent', () => {
        assert.equal(name('C--dev-webapp'), 'webapp');
    });

    it('names a drive-root project after the drive letter', () => {
        // Nothing else is left to name it after.
        assert.deepEqual(decodeProjectPath('C--'), { name: 'C', fullPath: 'C:\\' });
    });
});

describe('decodeProjectPath — Unix paths', () => {
    it('rebuilds an absolute path from the leading dash', () => {
        assert.equal(fullPath('-Users-ed-work-app'), '/Users/ed/work/app');
    });

    it('rebuilds a path that is only one segment deep', () => {
        assert.deepEqual(decodeProjectPath('-project'), { name: 'project', fullPath: '/project' });
    });

    it('names a two-segment path after its last segment', () => {
        assert.deepEqual(decodeProjectPath('-tmp-scratch'), { name: 'scratch', fullPath: '/tmp/scratch' });
    });

    it('treats a non-letter first segment as a Unix path, not a drive', () => {
        assert.equal(fullPath('-1-dev-app'), '/1/dev/app');
    });
});

describe('decodeProjectPath — how much of the path becomes the name', () => {
    it('takes only the last few segments of a deeply nested Windows path', () => {
        assert.equal(name('C--dev-tools-extensions-vscode-my-extension'), 'vscode-my-extension');
    });

    it('takes only the last few segments of a deeply nested Unix path', () => {
        assert.equal(name('-Users-ed-work-clients-acme-site'), 'clients-acme-site');
    });

    it('skips the drive letter and the first folder before trimming', () => {
        // Four segments: the tail rule would keep three, the prefix rule keeps
        // two. The prefix rule wins, so `dev` never reaches the status bar.
        assert.equal(name('C--dev-my-app'), 'my-app');
    });

    it('keeps dashes that were part of the folder name', () => {
        // The whole point of joining the tail back with dashes: the encoding
        // cannot tell this apart from three nested folders, and the name a user
        // recognises is the one with the dashes in it.
        assert.equal(name('C--dev-my-cool-project'), 'my-cool-project');
        assert.equal(name('-home-ed-my-cool-project'), 'my-cool-project');
    });
});

describe('decodeProjectPath — nothing to decode', () => {
    it('falls back to Unknown for an empty name', () => {
        assert.deepEqual(decodeProjectPath(''), { name: 'Unknown', fullPath: '/' });
    });

    it('falls back to Unknown for a name that is only separators', () => {
        // Never '': the status bar item stays readable and clickable.
        assert.equal(name('-'), 'Unknown');
        assert.equal(name('---'), 'Unknown');
    });
});
