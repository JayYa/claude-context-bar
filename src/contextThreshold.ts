/** How a session's context consumption is coloured in the status bar. */
export type ContextTokenLevel = 'normal' | 'warning' | 'danger';

/**
 * Pure function: classify a session's consumed context against the warning and
 * danger thresholds.
 *
 * Thresholds are absolute token counts, not percentages. A percentage is not
 * comparable across models: with windows ranging from 200K (Haiku, legacy) to
 * 1M (current frontier models), the same percentage stands for wildly
 * different amounts of loaded context. What degrades output quality is the
 * absolute amount loaded, so a fixed token count means the same thing whatever
 * the window size.
 *
 * Both thresholds are inclusive, and danger is tested first so that an
 * inverted pair (warning above danger) degrades to danger-only rather than
 * throwing. That misconfiguration is documented in the setting descriptions
 * rather than validated at runtime.
 *
 * A threshold of 0 switches its level off, matching the `idleTimeout: 0`
 * convention. Read literally, `dangerTokens: 0` would mean "every session is
 * red", the opposite of what someone typing 0 to disable colouring wants.
 *
 * @param totalTokens    Tokens consumed by the session
 * @param warningTokens  Consumption at which to warn; 0 or less disables the level
 * @param dangerTokens   Consumption at which to flag danger; 0 or less disables the level
 */
export function getContextTokenLevel(
    totalTokens: number,
    warningTokens: number,
    dangerTokens: number,
): ContextTokenLevel {
    if (dangerTokens > 0 && totalTokens >= dangerTokens) {
        return 'danger';
    }

    if (warningTokens > 0 && totalTokens >= warningTokens) {
        return 'warning';
    }

    return 'normal';
}
