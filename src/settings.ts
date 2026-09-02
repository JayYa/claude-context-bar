/**
 * The Settings snapshot: every setting value read in one go at the start of a
 * refresh, held read-only for the rest of that refresh and passed down by
 * parameter. It is a snapshot, not a handle you can ask for a fresh value
 * through — code that holds one reads what that refresh saw, and the next
 * refresh takes a new snapshot.
 *
 * This module is the extension's single point of contact with VS Code's
 * settings: what settings exist, what they default to, and what happens to an
 * illegal value all live here. It is free of `vscode` at runtime — the reader
 * it takes is a port, so tests drive it with a plain object.
 *
 * The single source of truth for defaults is `package.json`. The table below
 * is a mirror of it, reconciled item by item in `settings.test.ts`; adding a
 * setting to only one side fails that test.
 */

import { StatusBarLabel } from './statusBarText';

/**
 * Port for reading setting values: by key, with a fallback for when the key is
 * not set. VS Code's `WorkspaceConfiguration` satisfies this as-is, so the
 * production side passes it straight in with no adapter.
 */
export interface SettingsReader {
    get<T>(key: string, fallback: T): T;
}

/**
 * One refresh's worth of setting values.
 *
 * Flat by design: the fields are ordered by the five settings groups (see
 * CONTEXT.md) and sectioned with comments, but the grouping stays a comment.
 * A group decides where a setting appears in the settings UI and the README —
 * a presentation decision, which nesting would hard-code into every call site.
 */
export interface Settings {
    // --- Appearance ---------------------------------------------------------
    readonly label: StatusBarLabel;
    readonly compactMode: boolean;
    readonly shortNames: Record<string, string>;
    readonly showEmoji: boolean;
    readonly autoColor: boolean;
    readonly baseColor: string;

    // --- Context Window -----------------------------------------------------
    readonly contextLimit: number;
    readonly modelContextLimits: Record<string, number>;
    readonly warningTokens: number;
    readonly dangerTokens: number;

    // --- Subscription Usage -------------------------------------------------
    readonly showUsage: boolean;
    readonly usageWarningThreshold: number;
    readonly usageDangerThreshold: number;
    readonly usageRefreshInterval: number;

    // --- Behavior -----------------------------------------------------------
    readonly refreshInterval: number;
    readonly idleTimeout: number;

    // --- Data Source --------------------------------------------------------
    /**
     * The raw string the user typed, not a resolved directory. Resolving it
     * pulls in the environment and the home directory, which is the configDir
     * module's business — a different seam.
     */
    readonly configDir: string;
}

/** Mirror of the defaults declared in `package.json`. */
export const SETTINGS_DEFAULTS: Settings = {
    // --- Appearance ---------------------------------------------------------
    label: 'project',
    compactMode: false,
    shortNames: {},
    showEmoji: true,
    autoColor: true,
    baseColor: 'White',

    // --- Context Window -----------------------------------------------------
    contextLimit: 200000,
    modelContextLimits: {},
    warningTokens: 120000,
    dangerTokens: 150000,

    // --- Subscription Usage -------------------------------------------------
    showUsage: false,
    usageWarningThreshold: 50,
    usageDangerThreshold: 75,
    usageRefreshInterval: 60,

    // --- Behavior -----------------------------------------------------------
    refreshInterval: 30,
    idleTimeout: 180,

    // --- Data Source --------------------------------------------------------
    configDir: '',
};

/**
 * A context budget of zero or less would make the consumed percentage divide
 * by zero and read as `Infinity%`, so a non-positive budget falls back to the
 * default allowance.
 *
 * This is the only numeric validation done here. `warningTokens`, `dangerTokens` and
 * `idleTimeout` all document `0` as "switch this off", an existing meaning
 * that passes through untouched.
 */
function budgetOrDefault(value: number, fallback: number): number {
    return typeof value === 'number' && value > 0 ? value : fallback;
}

/** Drop non-positive per-model overrides so those models resolve normally. */
function positiveLimitsOnly(limits: Record<string, number>): Record<string, number> {
    const kept: Record<string, number> = {};
    for (const [model, limit] of Object.entries(limits ?? {})) {
        if (typeof limit === 'number' && limit > 0) {
            kept[model] = limit;
        }
    }
    return kept;
}

/** Take one Settings snapshot through the given reader. */
export function readSettings(reader: SettingsReader): Settings {
    const defaults = SETTINGS_DEFAULTS;

    return {
        // --- Appearance -----------------------------------------------------
        label: reader.get<StatusBarLabel>('label', defaults.label),
        compactMode: reader.get<boolean>('compactMode', defaults.compactMode),
        shortNames: reader.get<Record<string, string>>('shortNames', defaults.shortNames),
        showEmoji: reader.get<boolean>('showEmoji', defaults.showEmoji),
        autoColor: reader.get<boolean>('autoColor', defaults.autoColor),
        baseColor: reader.get<string>('baseColor', defaults.baseColor),

        // --- Context Window -------------------------------------------------
        contextLimit: budgetOrDefault(reader.get<number>('contextLimit', defaults.contextLimit), defaults.contextLimit),
        modelContextLimits: positiveLimitsOnly(
            reader.get<Record<string, number>>('modelContextLimits', defaults.modelContextLimits),
        ),
        warningTokens: reader.get<number>('warningTokens', defaults.warningTokens),
        dangerTokens: reader.get<number>('dangerTokens', defaults.dangerTokens),

        // --- Subscription Usage ---------------------------------------------
        showUsage: reader.get<boolean>('showUsage', defaults.showUsage),
        usageWarningThreshold: reader.get<number>('usageWarningThreshold', defaults.usageWarningThreshold),
        usageDangerThreshold: reader.get<number>('usageDangerThreshold', defaults.usageDangerThreshold),
        usageRefreshInterval: reader.get<number>('usageRefreshInterval', defaults.usageRefreshInterval),

        // --- Behavior -------------------------------------------------------
        refreshInterval: reader.get<number>('refreshInterval', defaults.refreshInterval),
        idleTimeout: reader.get<number>('idleTimeout', defaults.idleTimeout),

        // --- Data Source ----------------------------------------------------
        // A key present but explicitly `null` in settings.json is a value, so
        // the reader hands it back instead of falling back; the empty string is
        // what "not configured" means downstream.
        configDir: reader.get<string>('configDir', defaults.configDir) ?? defaults.configDir,
    };
}
