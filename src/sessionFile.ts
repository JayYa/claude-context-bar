import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface TokenUsage {
    inputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    totalTokens: number;
    model: string;
    firstMessage: string;
    sessionCreated: Date | null;
    wasCleared: boolean;  // True if session ended with /clear command
}

export function getClaudeProjectsDir(): string {
    const homeDir = os.homedir();
    return path.join(homeDir, '.claude', 'projects');
}

function guessProjectName(parts: string[]): string {
    // Use last few segments for a readable project name, not the full path chain.
    // Skip the first two path segments (drive/root + top-level folder) and
    // limit to the last 3 segments for deeply nested paths.
    if (parts.length >= 3) {
        const startIndex = Math.max(2, parts.length - 3);
        return parts.slice(startIndex).join('-');
    }
    return parts[parts.length - 1] || 'Unknown';
}

export function decodeProjectPath(encodedName: string): { name: string; fullPath: string } {
    // Claude encodes paths like: C--dev-my-cool-project or -Users-name-work-my-project
    // The double-dash after drive letter represents the colon (C: -> C--)
    // Single dashes represent path separators, BUT folder names can also contain dashes
    //
    // Strategy: Detect OS from the pattern and reconstruct path
    let decoded = encodedName;

    // Remove leading dash if present
    if (decoded.startsWith('-')) {
        decoded = decoded.substring(1);
    }

    // Split by dashes and filter out empty strings (from double-dashes)
    const parts = decoded.split('-').filter(p => p.length > 0);

    // Check if Windows pattern (first part is single drive letter like 'c', 'd', etc.)
    if (parts.length > 0 && parts[0].length === 1 && /[a-zA-Z]/.test(parts[0])) {
        // Windows path: C:\dev\my-cool-project
        // Claude typically encodes as: C--dev-my-cool-project
        // After filtering empty strings: ['C', 'dev', 'my', 'cool', 'project']
        const fullPath = parts[0].toUpperCase() + ':\\' + parts.slice(1).join('\\');
        return { name: guessProjectName(parts), fullPath };
    }

    // Unix path: /Users/Ed/work/my-project
    const fullPath = '/' + parts.join('/');
    return { name: guessProjectName(parts), fullPath };
}

const EMPTY_TOKEN_USAGE: TokenUsage = {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    model: '',
    firstMessage: '',
    sessionCreated: null,
    wasCleared: false,
};

function isCommandMessage(msg: unknown): boolean {
    if (typeof msg !== 'string') return false;
    return msg.includes('<command-name>') ||
        msg.includes('<local-command-') ||
        msg.includes('Caveat:');
}

// Exported via _test for testing
function findLastClearIndex(lines: string[]): number {
    for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        try {
            const entry = JSON.parse(lines[i]);
            if (entry.type === 'user' && entry.message?.content) {
                const msg = entry.message.content;
                if (typeof msg === 'string' && msg.includes('<command-name>/clear</command-name>')) {
                    return i;
                }
            }
        } catch (e) { continue; }
    }
    return -1;
}

// Exported via _test for testing
function countUserMessagesAfter(lines: string[], index: number): number {
    let count = 0;
    for (let i = index + 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try {
            const entry = JSON.parse(lines[i]);
            if (entry.type === 'user' && entry.message?.content) {
                if (!isCommandMessage(entry.message.content)) {
                    count++;
                }
            }
        } catch (e) { continue; }
    }
    return count;
}

// Exported via _test for testing
function extractUsage(lines: string[], fromIndex: number): {
    inputTokens: number; cacheReadTokens: number; cacheCreationTokens: number;
} {
    let usage = { inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    for (let i = fromIndex; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try {
            const entry = JSON.parse(lines[i]);
            const u = entry.message?.usage || entry.usage;
            if (u) {
                usage = {
                    inputTokens: u.input_tokens || 0,
                    cacheReadTokens: u.cache_read_input_tokens || 0,
                    cacheCreationTokens: u.cache_creation_input_tokens || 0,
                };
            }
        } catch (e) { continue; }
    }
    return usage;
}

// Exported via _test for testing
function extractModel(lines: string[], fromIndex: number): string {
    let model = '';
    for (let i = fromIndex; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try {
            const entry = JSON.parse(lines[i]);
            if (entry.message?.model) {
                model = entry.message.model;
            }
        } catch (e) { continue; }
    }
    return model;
}

// Exported via _test for testing
function findFirstUserMessage(lines: string[], fromIndex: number): string {
    for (let i = fromIndex; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try {
            const entry = JSON.parse(lines[i]);
            if (entry.type !== 'user' || !entry.message?.content) continue;
            const msg = entry.message.content;
            if (typeof msg === 'string' && !isCommandMessage(msg)) {
                return msg.substring(0, 60);
            } else if (Array.isArray(msg) && msg[0]?.text) {
                return msg[0].text.substring(0, 60);
            }
        } catch (e) { continue; }
    }
    return '';
}

// Exported via _test for testing
function extractFirstTimestamp(lines: string[], fromIndex: number): Date | null {
    for (let i = fromIndex; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try {
            const entry = JSON.parse(lines[i]);
            if (entry.timestamp) {
                return new Date(entry.timestamp);
            }
        } catch (e) { continue; }
    }
    return null;
}

export const _test = {
    findLastClearIndex,
    countUserMessagesAfter,
    extractUsage,
    extractModel,
    findFirstUserMessage,
    extractFirstTimestamp,
};

export async function getLatestTokenCount(
    jsonlPath: string,
    readFile?: (path: string) => string
): Promise<TokenUsage> {
    const read = readFile || ((p: string) => fs.readFileSync(p, 'utf-8'));

    return new Promise((resolve) => {
        try {
            const stats = fs.statSync(jsonlPath);
            if (stats.size === 0) {
                resolve({ ...EMPTY_TOKEN_USAGE });
                return;
            }

            const content = read(jsonlPath);
            const lines = content.trim().split('\n');

            const lastClearIndex = findLastClearIndex(lines);
            const messagesAfterClear = countUserMessagesAfter(lines, lastClearIndex);
            const wasCleared = (lastClearIndex !== -1 && messagesAfterClear === 0);

            const startIndex = lastClearIndex >= 0 ? lastClearIndex + 1 : 0;

            const usage = extractUsage(lines, startIndex);
            const model = extractModel(lines, startIndex);
            const firstMsg = findFirstUserMessage(lines, startIndex);
            const created = extractFirstTimestamp(lines, startIndex);

            resolve({
                inputTokens: usage.inputTokens,
                cacheReadTokens: usage.cacheReadTokens,
                cacheCreationTokens: usage.cacheCreationTokens,
                totalTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
                model,
                firstMessage: firstMsg ? firstMsg + '...' : '',
                sessionCreated: created,
                wasCleared,
            });
        } catch (e) {
            resolve({ ...EMPTY_TOKEN_USAGE });
        }
    });
}
