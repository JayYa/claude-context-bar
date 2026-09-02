import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { readSettings, SettingsReader, Settings, SETTINGS_DEFAULTS } from './settings';

// --- fixtures ---------------------------------------------------------------
//
// The port has a single method, so the fake is a plain object: it answers from
// a map of set values, falls back exactly as VS Code does, and records what it
// was asked for so a case can pin down which key a field came from.

const SECTION = 'claudeContextBar';

interface RecordedRead {
    key: string;
    fallback: unknown;
}

interface FakeReader extends SettingsReader {
    reads: RecordedRead[];
}

function fakeReader(values: Record<string, unknown> = {}): FakeReader {
    const reads: RecordedRead[] = [];

    return {
        reads,
        get<T>(key: string, fallback: T): T {
            reads.push({ key, fallback });
            return key in values ? (values[key] as T) : fallback;
        },
    };
}

/** The settings declared in `package.json`, keyed without the section prefix. */
function manifestSettings(): Record<string, { default: unknown }> {
    // Tests run from the compiled output dir, so the manifest sits one level up.
    const manifestPath = path.join(__dirname, '..', 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const groups: Array<{ properties: Record<string, { default: unknown }> }> =
        manifest.contributes.configuration;

    const settings: Record<string, { default: unknown }> = {};
    for (const group of groups) {
        for (const [fullKey, property] of Object.entries(group.properties)) {
            settings[fullKey.slice(SECTION.length + 1)] = property;
        }
    }
    return settings;
}

/**
 * One case per setting: the key it is read from, and a value distinct from the
 * default so "read the right key" cannot pass by accident. Numbers stay
 * positive: the non-positive cases belong to the validation block below.
 */
const CASES: Array<{ field: keyof Settings; value: unknown }> = [
    // Appearance
    { field: 'label', value: 'session' },
    { field: 'compactMode', value: true },
    { field: 'shortNames', value: { 'my-cool-project': 'MCP' } },
    { field: 'showEmoji', value: false },
    { field: 'autoColor', value: false },
    { field: 'baseColor', value: 'Cyan' },
    // Context Window
    { field: 'contextLimit', value: 500_000 },
    { field: 'modelContextLimits', value: { 'claude-haiku-4-5': 500_000 } },
    { field: 'warningTokens', value: 90_000 },
    { field: 'dangerTokens', value: 110_000 },
    // Subscription Usage
    { field: 'showUsage', value: true },
    { field: 'usageWarningThreshold', value: 40 },
    { field: 'usageDangerThreshold', value: 80 },
    { field: 'usageRefreshInterval', value: 120 },
    // Behavior
    { field: 'refreshInterval', value: 5 },
    { field: 'idleTimeout', value: 600 },
    // Data Source
    { field: 'configDir', value: '~/work/.claude' },
];

// --- tests ------------------------------------------------------------------

describe('SETTINGS_DEFAULTS — reconciled with package.json', () => {
    const manifest = manifestSettings();

    it('declares exactly the settings package.json declares', () => {
        assert.deepEqual(
            Object.keys(SETTINGS_DEFAULTS).sort(),
            Object.keys(manifest).sort(),
        );
    });

    for (const key of Object.keys(SETTINGS_DEFAULTS).sort()) {
        it(`defaults ${key} to the value package.json advertises`, () => {
            assert.deepEqual(
                SETTINGS_DEFAULTS[key as keyof Settings],
                manifest[key]?.default,
            );
        });
    }
});

describe('readSettings — delegation to the reader', () => {
    for (const { field, value } of CASES) {
        it(`reads ${field} from the ${field} key`, () => {
            const reader = fakeReader({ [field]: value });

            assert.deepEqual(readSettings(reader)[field], value);
        });
    }

    for (const field of Object.keys(SETTINGS_DEFAULTS) as Array<keyof Settings>) {
        it(`falls back to the default for ${field} when it is not set`, () => {
            assert.deepEqual(readSettings(fakeReader())[field], SETTINGS_DEFAULTS[field]);
        });
    }

    it('passes the code-side default as the fallback for every key', () => {
        const reader = fakeReader();
        readSettings(reader);

        for (const { key, fallback } of reader.reads) {
            assert.deepEqual(fallback, SETTINGS_DEFAULTS[key as keyof Settings]);
        }
    });

    it('reads each setting exactly once', () => {
        const reader = fakeReader();
        readSettings(reader);

        assert.deepEqual(
            reader.reads.map(r => r.key).sort(),
            Object.keys(SETTINGS_DEFAULTS).sort(),
        );
    });
});

describe('readSettings — context budget validation', () => {
    // A budget of zero or less would divide the consumed percentage by zero and
    // surface as `Infinity%`, so it falls back to the default allowance.

    it('keeps a positive contextLimit', () => {
        assert.equal(readSettings(fakeReader({ contextLimit: 1 })).contextLimit, 1);
    });

    it('falls back to the default when contextLimit is 0', () => {
        assert.equal(
            readSettings(fakeReader({ contextLimit: 0 })).contextLimit,
            SETTINGS_DEFAULTS.contextLimit,
        );
    });

    it('falls back to the default when contextLimit is negative', () => {
        assert.equal(
            readSettings(fakeReader({ contextLimit: -1 })).contextLimit,
            SETTINGS_DEFAULTS.contextLimit,
        );
    });

    it('keeps a positive modelContextLimits entry', () => {
        const limits = { 'claude-haiku-4-5': 1 };

        assert.deepEqual(readSettings(fakeReader({ modelContextLimits: limits })).modelContextLimits, limits);
    });

    it('drops a modelContextLimits entry of 0', () => {
        const limits = { 'claude-haiku-4-5': 0 };

        assert.deepEqual(readSettings(fakeReader({ modelContextLimits: limits })).modelContextLimits, {});
    });

    it('drops a negative modelContextLimits entry', () => {
        const limits = { 'claude-haiku-4-5': -1 };

        assert.deepEqual(readSettings(fakeReader({ modelContextLimits: limits })).modelContextLimits, {});
    });

    it('drops only the offending modelContextLimits entry', () => {
        const limits = { 'claude-haiku-4-5': 0, 'claude-opus-5': 500_000 };

        assert.deepEqual(
            readSettings(fakeReader({ modelContextLimits: limits })).modelContextLimits,
            { 'claude-opus-5': 500_000 },
        );
    });
});

describe('readSettings — 0 keeps its documented "off" meaning', () => {
    it('passes warningTokens of 0 through', () => {
        assert.equal(readSettings(fakeReader({ warningTokens: 0 })).warningTokens, 0);
    });

    it('passes dangerTokens of 0 through', () => {
        assert.equal(readSettings(fakeReader({ dangerTokens: 0 })).dangerTokens, 0);
    });

    it('passes idleTimeout of 0 through', () => {
        assert.equal(readSettings(fakeReader({ idleTimeout: 0 })).idleTimeout, 0);
    });
});
