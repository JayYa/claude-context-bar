# Changelog

All notable changes to the Claude Context Bar extension will be documented in this file.

## [Unreleased]

### Fixed
- **`refreshInterval` and `usageRefreshInterval` changes now take effect immediately, without reloading the window.** Both intervals were read once at activation, so editing either one only forced a single extra refresh — the polling cadence itself kept running at the value in force when the window opened, and nothing said so. The configuration watcher now clears both timers and recreates them from the new settings on any `claudeContextBar` change, in that order, so repeatedly adjusting an interval never leaves earlier timers running alongside the current one. Slower intervals take effect just as promptly as faster ones. Changing a setting unrelated to the intervals still refreshes as before.

## [1.7.1] - 2026-09-02

A settings reorganisation only: no retained setting changed its default value or its meaning, so nothing needs re-tuning.

### Changed
- **New settings section — Data Source（数据来源）**, ordered last in the VS Code settings UI, holding `claudeContextBar.configDir` as its sole member. Data Source is where the extension reads its data from — where on disk it looks for Claude Code's own files. `configDir` used to sit under **Behavior**, but Behavior decides *when* the extension acts and when an item appears or disappears, while `configDir` decides *where* it reads from. Behavior is now just `refreshInterval` and `idleTimeout`. This is a regrouping only: `configDir` keeps its type, its default and its description, and no setting changed its behavior.
- **Appearance settings reordered to content-before-form**: `label` → `compactMode` → `shortNames` → `showEmoji` → `autoColor` → `baseColor`. `label` decides *which* name the status bar shows, so it now comes before the two settings that reshape that name; the first three read as "what name" and the last three as "how it is decorated". The rule that a toggle is immediately followed by the settings it governs is preserved (`autoColor` stays next to `baseColor`).
- **`compactMode` and `shortNames` descriptions now state that they only apply when `label` is `project`.** This has always been true — in `session` mode the status bar shows the session title truncated and never consults the abbreviated name — but nothing in the settings UI said so. Placing the two settings directly under `label` would otherwise imply they compose with every `label` value. Documentation only: no behavior changed, and abbreviation still does not apply in `session` mode.
- README configuration tables restructured into the five sections in their new order, with `configDir` in the Data Source table.

### Removed
- **`claudeContextBar.usageFormat`** — removed one release after it was added. Context Window colors are driven by absolute token counts (`warningTokens` / `dangerTokens`) because a percentage is not comparable across a 200K and a 1M window. With `usageFormat` set to `percent`, the number on the status bar was no longer the quantity that decided its color — yellow could appear next to a percentage that looked small. The status bar number is now always a formatted token count. The `UsageFormat` type and the `formatUsageValue` helper are deleted too, so there is no dormant branch back to the mismatch. The hover tooltip still shows the percentage alongside the absolute count and the resolved window size; there is no color in a tooltip, so the mismatch does not arise there.
- **`claudeContextBar.warningThreshold`** and **`claudeContextBar.dangerThreshold`** — declarations deleted. Their values have not been read since 1.6.4; they survived only to carry a deprecation notice, and this fork has a single user, so the migration window is over. The stale values are percentages and are simply discarded, not converted into token counts: the current `warningTokens` / `dangerTokens` defaults already express how full a context window has to get before output quality suffers.

## [1.7.0] - 2026-09-01

### Added
- **`claudeContextBar.configDir`** — locate sessions (and usage credentials) outside `~/.claude`. Resolution order: this setting, then `CLAUDE_CONFIG_DIR`, then `~/.claude`. Covers GUI-launched VS Code that does not inherit a shell-only env var (#12). If a relocated dir is missing, a warning item appears instead of a blank bar.
- **`claudeContextBar.label`** — `project` (default) or `session`. Session mode uses the Claude Code title from `/rename` / `-n` (`custom-title`) or the generated summary (`ai-title`), truncated to fit the status bar (#11).
- **`claudeContextBar.usageFormat`** — `tokens` (default, e.g. `185K`) or `percent`, bringing back the percentage display that 1.6.4 replaced. This only changes the number on the status bar: warning and danger colors are unaffected and still use the absolute `warningTokens` / `dangerTokens` counts (#10).
- Hover tooltips always include the session title when Claude Code has written one.

### Changed
- File watcher follows config-dir changes and starts watching if the folder appears later.
- Subscription usage credentials use the same resolved config directory as session files.

## [1.6.4] - 2026-08-26

### Changed
- **Context colors are now based on absolute token counts instead of percentages of the context window.** New settings `warningTokens` (default 120,000) and `dangerTokens` (default 150,000) replace `warningThreshold` and `dangerThreshold`. A percentage is not comparable across models — with windows ranging from 200K (Haiku, legacy) to 1M (current frontier models), the same percentage stands for wildly different amounts of loaded context — and what degrades output quality is the absolute amount loaded. Set either to `0` to disable that color, matching the `idleTimeout: 0` convention.
- Status bar items now show consumed tokens (`myproj: 120K`) rather than a percentage, so the number on screen is the one that explains the color. The hover tooltip is unchanged and still shows the percentage, the full token breakdown and the resolved context window size.
- Settings are now split into four labeled sections in the VS Code settings UI — **Appearance**, **Context Window**, **Subscription Usage** and **Behavior** — and ordered within each section so that a toggle is immediately followed by the settings it governs (`autoColor` → `baseColor`, `showUsage` → its thresholds and interval). No setting was renamed, added, removed, or given a new default; existing `settings.json` files keep working unchanged.
- Setting descriptions that contain examples or cross-references now render as Markdown, so JSON examples appear as code and `baseColor`/`modelContextLimits` link to the settings they depend on.
- README configuration table split into one table per section, matching the settings UI order.

### Deprecated
- `claudeContextBar.warningThreshold` and `claudeContextBar.dangerThreshold` are no longer read. They remain declared so VS Code can show a deprecation notice pointing at their replacements; existing values in `settings.json` are left untouched rather than rewritten, and can be deleted at your convenience. Subscription usage thresholds (`usageWarningThreshold`, `usageDangerThreshold`) are **not** affected and stay percentage-based, because that endpoint reports only a percentage.

## [1.6.0] - 2026-07-24

### Added
- **Subscription usage monitor** (opt-in, off by default) — shows your Claude `/usage` Session (5-hour) limit as a separate status bar item (e.g. `✴️ 7%`) to the right of the context items.
  - Usage percentage has its own warning/danger colors, independent of the context colors, via `usageWarningThreshold` (default 50) and `usageDangerThreshold` (default 75).
  - Hover tooltip shows all subscription limits — Session (5h), Weekly (all models), and any scoped weekly limits (e.g. Weekly Fable) — with reset times.
  - Data comes from the authenticated `GET /api/oauth/usage` endpoint, using the OAuth token from the OS credential store (macOS Keychain or `~/.claude/.credentials.json`), exactly as Claude Code does. The token is only used as a request header and is never logged.
  - Refreshes on its own cadence (`usageRefreshInterval`, default 60s), keeps the last known value on transient failures.
  - Enable with the `showUsage` setting (default off). Automatically hides when not signed in with a subscription (e.g. API-key auth).
  - Note: `/api/oauth/usage` is an undocumented endpoint reverse-engineered from Claude Code; treat this feature as a temporary bonus that may stop working at any time. The parser is defensive (two schema paths, tolerant field reading) and degrades to hiding the item rather than erroring.
- Unit tests for the usage response parser (`parseUsage`), covering the canonical `limits` array and the flat-meter fallback.

## [1.5.1] - 2026-07-22

### Changed
☼ `idleTimeout` no longer capped at 600 seconds: any value up to 9999999 is accepted, and `0` disables the timeout entirely so idle sessions never hide (#7)

### Added
☼ Sessions rescan when the VS Code window regains focus, so a resumed session's bar returns as soon as it has fresh activity instead of waiting for the next poll (#6)

## [1.5.0] - 2026-07-06

### Changed
☼ **Context limit auto-detection rewritten** to default to 1M and list the 200K exceptions, instead of the old `sonnet` + `1m` heuristic that missed nearly every model.

  ☼ **1M by default**: every current Claude model (Opus 4.6+, Sonnet 4.6+, Sonnet 5, Fable 5, and anything newer) resolves to 1,000,000 tokens. New models are detected automatically with no extension update.
  
  ☼ **200K exceptions**: Haiku (all versions) and legacy generations (Claude 3.x, Sonnet 4.5 and earlier, Opus 4.5 and earlier) resolve to 200,000.
  
  ☼ **Fallback**: unknown or non-Claude Model IDs use the `contextLimit` setting (default 200,000).
  
☼ Extracted the resolution into a pure `getContextLimitForModel` function.

### Added
☼ `claudeContextBar.modelContextLimits` setting: per-model overrides (object, default `{}`). Exact Model ID match, highest priority. No model is force-capped.

☼ Unit test suite (25 tests) run with Node's built-in test runner (`npm test`, no extra dependencies).

## [1.4.1] - 2025-12-29

### Fixed
- Added compact mode documentation to README

## [1.4.0] - 2025-12-29

### Added
- **Compact Mode**: Shorten project names to save status bar space
  - Multi-word names become acronyms (my-cool-project → MCP)
  - Single words become abbreviated (typescript → Tscript)
  - Names 5 characters or less stay unchanged
  - Session numbers preserved (MCP-2, MCP-3)
- **Custom Short Names**: Define your own abbreviations via `shortNames` setting
- **Instant Settings Refresh**: All settings now apply immediately without waiting for next refresh cycle

## [1.3.0] - 2025-12-24

### Added
- **Click to Hide**: Click any status bar item to temporarily hide it
  - Hidden sessions automatically reappear when there's new activity
  - Great for dismissing stale sessions you're not actively using
- **Configurable Idle Timeout**: New `idleTimeout` setting (default: 180 seconds / 3 minutes)
  - Sessions inactive longer than this are automatically hidden
  - Reduced from previous hardcoded 5 minutes
  - Range: 10-600 seconds

### Fixed
- **Project Name Display**: Fixed deeply nested paths showing full folder chain
  - Now correctly shows last 3 path segments (e.g., "claude-context-bar" instead of "Tools-extensions-vscode-claude-context-bar")

## [1.2.2] - 2025-12-23

### Fixed
- Documentation updates

## [1.2.1] - 2025-12-23

### Fixed
- **Project Name Display**: Fixed issue where parent folder (e.g., "dev") was incorrectly included in project names
  - Now correctly shows "my-project" instead of "dev-my-project"
- **Tooltip Cleanup**: Removed confusing "New Input" row (always showed ~8 tokens)

## [1.2.0] - 2025-12-22

### Added
- **Smart Session Detection**: Automatically detects and hides "ghost" sessions
  - Sessions are hidden immediately when superseded by a newer session
  - Properly handles `/clear` command scenarios
  - No more lingering status bar items from closed tabs
- **First Message in Tooltip**: Shows the first message of each session to help identify which Claude Code tab it corresponds to

### Fixed
- Ghost sessions no longer appear after running `/clear` and continuing work
- Improved session lifecycle tracking using creation timestamps

## [1.1.3] - 2025-12-22

### Added
- **Fuzzy Emoji Matching**: Icons automatically match project type based on name keywords
  - Music projects (🎵), games (🎮), web (🌐), mobile (📱), AI (🤖), and more
- `showEmoji` setting to toggle emoji display on/off (default: on)

## [1.1.2] - 2025-12-22

### Added
- Now available on [Open VSX Registry](https://open-vsx.org/extension/ezoosk/claude-context-bar) for Antigravity, VSCodium, and other VS Code forks
- Automated dual-publishing to both VS Code Marketplace and Open VSX

## [1.1.0] - 2025-12-22

### Added
- **Auto Color Mode**: Pastel color palette assigns different colors to each project automatically
- **Base Color Selection**: When auto-color is off, choose a base color with subtle variations per project
- **Auto Context Limit Detection**: Automatically detects model (Sonnet 4.5 1M vs others) and adjusts context limit
- Model name now displayed in tooltip

### Changed
- Color palette changed to softer pastel colors for better readability

## [1.0.0] - 2025-12-22

### Added
- Real-time context window usage monitoring for Claude Code sessions
- Status bar indicators for each active Claude Code tab
- Color-coded warnings: yellow at 50%, red at 75%
- Detailed tooltip with token breakdown (cache read, cache creation, new input)
- Configurable context limit, thresholds, and refresh interval
- Auto-refresh on file changes and periodic polling
- Automatic cleanup of stale sessions (5-minute timeout)
- Excludes Claude Memory background processes from display
