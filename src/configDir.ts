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
 */
import * as os from 'os';
import * as path from 'path';

export interface ResolveClaudeConfigDirOptions {
    setting?: string;
    env?: NodeJS.ProcessEnv;
    homedir?: string;
}

export function expandHome(p: string, homedir: string): string {
    if (p === '~') {
        return homedir;
    }
    if (p.startsWith('~/') || p.startsWith('~\\')) {
        return path.join(homedir, p.slice(2));
    }
    return p;
}

export function resolveClaudeConfigDir(options: ResolveClaudeConfigDirOptions = {}): string {
    const homedir = options.homedir ?? os.homedir();
    const setting = (options.setting ?? '').trim();
    if (setting) {
        return expandHome(setting, homedir);
    }
    const envDir = (options.env ?? process.env).CLAUDE_CONFIG_DIR?.trim();
    if (envDir) {
        return expandHome(envDir, homedir);
    }
    return path.join(homedir, '.claude');
}

export function claudeProjectsDir(configDir: string): string {
    return path.join(configDir, 'projects');
}

/** True when the resolved path is the default ~/.claude (no relocation). */
export function isDefaultClaudeConfigDir(dir: string, homedir: string = os.homedir()): boolean {
    return path.normalize(path.resolve(dir)) === path.normalize(path.resolve(path.join(homedir, '.claude')));
}

/** True when the user explicitly relocated config via setting or env. */
export function hasExplicitConfigDir(setting?: string, env: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean((setting ?? '').trim() || (env.CLAUDE_CONFIG_DIR ?? '').trim());
}
