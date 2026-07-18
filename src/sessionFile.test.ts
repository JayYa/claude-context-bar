import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeProjectPath } from './sessionFile';

describe('decodeProjectPath', () => {
    describe('Windows paths', () => {
        it('decodes a shallow Windows path (C--dev-webapp)', () => {
            const result = decodeProjectPath('C--dev-webapp');
            assert.equal(result.fullPath, 'C:\\dev\\webapp');
            assert.equal(result.name, 'webapp');
        });

        it('decodes a deep nested Windows path', () => {
            const result = decodeProjectPath('C--dev-tools-extensions-vscode-my-extension');
            assert.equal(result.fullPath, 'C:\\dev\\tools\\extensions\\vscode\\my\\extension');
            assert.equal(result.name, 'vscode-my-extension');
        });

        it('handles Windows path with mixed-case drive letter', () => {
            const result = decodeProjectPath('d--Users-work-project');
            assert.equal(result.fullPath, 'D:\\Users\\work\\project');
            assert.equal(result.name, 'work-project');
        });
    });

    describe('Unix paths', () => {
        it('decodes a shallow Unix path (-Users-name-my-project)', () => {
            const result = decodeProjectPath('-Users-name-my-project');
            assert.equal(result.fullPath, '/Users/name/my/project');
            assert.equal(result.name, 'my-project');
        });

        it('decodes a deep nested Unix path', () => {
            const result = decodeProjectPath('-home-user-work-projects-my-app');
            assert.equal(result.fullPath, '/home/user/work/projects/my/app');
            assert.equal(result.name, 'projects-my-app');
        });
    });

    describe('leading dash stripping', () => {
        it('strips leading dash from a simple path', () => {
            const result = decodeProjectPath('-some-simple-path');
            assert.equal(result.fullPath, '/some/simple/path');
            assert.equal(result.name, 'path');
        });

        it('handles path with no leading dash', () => {
            const result = decodeProjectPath('Users-name-project');
            assert.equal(result.fullPath, '/Users/name/project');
            assert.equal(result.name, 'project');
        });
    });
});
