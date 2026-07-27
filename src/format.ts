/**
 * Formats a token count with K/M suffix for display.
 *
 * - ≥ 1,000,000 → "1.5M"
 * - ≥ 1,000     → "2K"
 * - < 1,000     → "500"
 */
export function formatTokens(tokens: number): string {
    if (tokens >= 1_000_000) {
        return (tokens / 1_000_000).toFixed(1) + 'M';
    } else if (tokens >= 1000) {
        return Math.round(tokens / 1000) + 'K';
    }
    return tokens.toString();
}
