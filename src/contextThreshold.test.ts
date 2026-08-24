import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getContextTokenLevel } from './contextThreshold';

describe('getContextTokenLevel', () => {
    const WARNING = 120_000;
    const DANGER = 150_000;

    // Normal band: below the warning threshold.

    it('is normal at zero tokens', () => {
        assert.equal(getContextTokenLevel(0, WARNING, DANGER), 'normal');
    });

    it('is normal just below warningTokens', () => {
        assert.equal(getContextTokenLevel(119_999, WARNING, DANGER), 'normal');
    });

    // Thresholds are inclusive: reaching the value trips the level.

    it('is warning exactly at warningTokens', () => {
        assert.equal(getContextTokenLevel(120_000, WARNING, DANGER), 'warning');
    });

    it('is warning between warningTokens and dangerTokens', () => {
        assert.equal(getContextTokenLevel(140_000, WARNING, DANGER), 'warning');
    });

    it('is warning just below dangerTokens', () => {
        assert.equal(getContextTokenLevel(149_999, WARNING, DANGER), 'warning');
    });

    it('is danger exactly at dangerTokens', () => {
        assert.equal(getContextTokenLevel(150_000, WARNING, DANGER), 'danger');
    });

    it('is danger well above dangerTokens', () => {
        assert.equal(getContextTokenLevel(900_000, WARNING, DANGER), 'danger');
    });

    // 0 disables a level, matching the `idleTimeout: 0` convention. Without
    // this, `dangerTokens: 0` would read as "every session is red", the exact
    // opposite of what someone typing 0 to switch colouring off intends.

    it('danger of 0 disables the danger level', () => {
        assert.equal(getContextTokenLevel(900_000, WARNING, 0), 'warning');
    });

    it('warning of 0 disables the warning level', () => {
        assert.equal(getContextTokenLevel(130_000, 0, DANGER), 'normal');
    });

    it('warning of 0 still lets danger trip', () => {
        assert.equal(getContextTokenLevel(200_000, 0, DANGER), 'danger');
    });

    it('both 0 disables colouring entirely', () => {
        assert.equal(getContextTokenLevel(5_000_000, 0, 0), 'normal');
    });

    it('a disabled level does not trip at 0 tokens', () => {
        assert.equal(getContextTokenLevel(0, 0, 0), 'normal');
    });

    // Misconfiguration degrades rather than throwing. Danger is checked first,
    // so an inverted pair collapses to danger-only; documented, not validated.

    it('inverted thresholds collapse to danger only', () => {
        assert.equal(getContextTokenLevel(160_000, 200_000, 150_000), 'danger');
    });

    it('inverted thresholds leave the band below danger normal', () => {
        assert.equal(getContextTokenLevel(140_000, 200_000, 150_000), 'normal');
    });

    it('equal thresholds report danger at the shared value', () => {
        assert.equal(getContextTokenLevel(150_000, 150_000, 150_000), 'danger');
    });

    // Defensive: negative configuration behaves like a disabled level rather
    // than tripping on every session.

    it('negative thresholds are treated as disabled', () => {
        assert.equal(getContextTokenLevel(100_000, -1, -1), 'normal');
    });
});
