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
