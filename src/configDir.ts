/**
 * Resolve Claude Code's config directory.
 *
 * Priority (highest first):
 * 1. `claudeContextBar.configDir` VS Code setting (covers GUI-launched editors
 *    that do not inherit a shell-only CLAUDE_CONFIG_DIR)
 * 2. CLAUDE_CONFIG_DIR environment variable
 * 3. ~/.claude
 *
 * The setting and env var name the config directory itself (the folder that
 * contains `projects/`), not the projects folder.
 *
 * Pure string helpers — callers inject env and homedir so this module type-checks
 * without Node's type packages (EZ-Verify's trusted tsc uses `"types": []`).
 */

export type EnvMap = Record<string, string | undefined>;

export interface ResolveClaudeConfigDirOptions {
    setting?: string;
    env?: EnvMap;
    homedir: string;
}

/** Read process.env without naming the Node `process` global. */
export function readProcessEnv(): EnvMap {
    const g = globalThis as unknown as { process?: { env?: EnvMap } };
    return g.process?.env ?? {};
}

export function defaultHomedir(env: EnvMap = readProcessEnv()): string {
    return (env.USERPROFILE || env.HOME || '').trim();
}

function join2(base: string, child: string): string {
    const sep = base.includes('\\') ? '\\' : '/';
    const trimmed = base.replace(/[\\/]+$/, '');
    const rest = child.replace(/^[\\/]+/, '');
    return trimmed + sep + rest;
}

function normalizePath(p: string): string {
    return p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

export function expandHome(p: string, homedir: string): string {
    if (p === '~') {
        return homedir;
    }
    if (p.startsWith('~/') || p.startsWith('~\\')) {
        return join2(homedir, p.slice(2));
    }
    return p;
}

export function resolveClaudeConfigDir(options: ResolveClaudeConfigDirOptions): string {
    const setting = (options.setting ?? '').trim();
    if (setting) {
        return expandHome(setting, options.homedir);
    }
    const envDir = (options.env ?? {}).CLAUDE_CONFIG_DIR?.trim();
    if (envDir) {
        return expandHome(envDir, options.homedir);
    }
    return join2(options.homedir, '.claude');
}

export function claudeProjectsDir(configDir: string): string {
    return join2(configDir, 'projects');
}

/** True when the resolved path is the default ~/.claude (no relocation). */
export function isDefaultClaudeConfigDir(dir: string, homedir: string): boolean {
    return normalizePath(dir) === normalizePath(join2(homedir, '.claude'));
}

/** True when the user explicitly relocated config via setting or env. */
export function hasExplicitConfigDir(setting?: string, env: EnvMap = {}): boolean {
    return Boolean((setting ?? '').trim() || (env.CLAUDE_CONFIG_DIR ?? '').trim());
}
