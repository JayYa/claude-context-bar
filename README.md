# Claude Context Bar

**Real-time context window monitor for Claude Code sessions in VS Code**

## Features

🧠 **Live Context Tracking** — See how many tokens your Claude Code session has consumed, right in the status bar

⚡ **Per-Tab Monitoring** — Each Claude Code tab gets its own context indicator

🏷️ **Session Titles** — Hover shows the Claude Code session name. Optionally use it on the status bar when several tabs share a project

🎯 **Fuzzy Emoji Matching** — Icons automatically match your project type based on name keywords:
- 🎵 Music/audio projects
- 🎮 Games
- 🌐 Web/frontend
- 📱 Mobile apps
- 🤖 AI/ML projects
- 🔧 Tools/extensions
- And many more...

🎨 **Auto Color Mode** — Each project automatically gets a unique pastel color for easy identification

🔍 **Smart Context Detection** — Automatically sizes the context window per model (1M for current models, 200K for Haiku and legacy), with per-model overrides

⚠️ **Color-Coded Warnings** — by absolute tokens consumed, so they mean the same thing on a 200K and a 1M model:
- Normal: under 120K tokens
- Warning (yellow background): 120K–150K tokens
- Danger (red background): over 150K tokens

📊 **Detailed Tooltips** — Hover to see:
- Session title (when Claude Code has generated or you have named one)
- First message
- Model name
- Cache Read / Cache Creation tokens
- Total context used vs limit
- Last updated time

🔄 **Auto-Refresh** — Updates automatically when sessions change or every 30 seconds

🧹 **Smart Session Detection** — Automatically hides "ghost" sessions when you close tabs or run `/clear`

👆 **Click to Hide** — Click any context bar item to temporarily hide it; reappears on new activity

📐 **Compact Mode** — Shorten project names to save space (my-cool-project → MCP, typescript → Tscript)

💯 **Token Display** — Optionally show absolute tokens on the status bar (185K) instead of percent (18%)

✴️ **Subscription Usage** — Opt-in (off by default): see your Claude `/usage` Session (5-hour) limit as its own status bar item (e.g. `✴️ 7%`), with color-coded warnings independent of the context colors. Hover for the full breakdown (Weekly, and per-model limits like Weekly Fable) with reset times. Experimental, may stop working at any time (see [Subscription usage](#subscription-usage))

## Requirements

- VS Code 1.74.0 or later
- [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) extension installed and active

**Install:**
- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ezoosk.claude-context-bar)
- [Open VSX Registry](https://open-vsx.org/extension/ezoosk/claude-context-bar) (for Antigravity, VSCodium, etc.)

## Configuration

Settings are grouped into five sections, matching the VS Code settings UI.

#### Appearance

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeContextBar.showEmoji` | `true` | Show emoji icons based on project name keywords |
| `claudeContextBar.autoColor` | `true` | Automatically assign unique pastel colors to each project |
| `claudeContextBar.baseColor` | `White` | Base color when Auto Color is off (subtle variations per project) |
| `claudeContextBar.compactMode` | `false` | Shorten project names to save status bar space |
| `claudeContextBar.shortNames` | `{}` | Custom short names for projects (e.g., `{"my-project": "MP"}`) |
| `claudeContextBar.label` | `project` | Status bar name: `project` (folder) or `session` (Claude Code title) |

#### Context Window

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeContextBar.contextLimit` | `200000` | Fallback for unknown or non-Claude model IDs (Claude models are auto-detected) |
| `claudeContextBar.modelContextLimits` | `{}` | Per-model overrides: Model ID → token limit (e.g., `{"claude-haiku-4-5": 500000}`). Exact match, highest priority |
| `claudeContextBar.warningTokens` | `120000` | Tokens consumed before the yellow warning color (`0` disables) |
| `claudeContextBar.dangerTokens` | `150000` | Tokens consumed before the red danger color (`0` disables) |

#### Subscription Usage

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeContextBar.showUsage` | `false` | Opt-in: show your Claude subscription usage (the 5-hour session limit from `/usage`) as a separate item. Experimental, may stop working at any time |
| `claudeContextBar.usageWarningThreshold` | `50` | Usage percentage for yellow warning (independent of context) |
| `claudeContextBar.usageDangerThreshold` | `75` | Usage percentage for red danger (independent of context) |
| `claudeContextBar.usageRefreshInterval` | `60` | How often (seconds) to refresh subscription usage from the `/usage` endpoint |

#### Behavior

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeContextBar.refreshInterval` | `30` | How often (seconds) to refresh context usage from session files |
| `claudeContextBar.idleTimeout` | `180` | Seconds of inactivity before hiding a session (3 minutes). Set `0` to never hide idle sessions |

#### Data Source

Where the extension reads its data from — which location on disk it looks in for Claude Code's own files.

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeContextBar.configDir` | `""` | Claude Code config directory (the folder that contains `projects/`). Empty = `CLAUDE_CONFIG_DIR`, then `~/.claude` |

## How It Works

The extension reads Claude Code's session files from `<configDir>/projects/` and calculates token usage from the JSONL logs. `<configDir>` is `claudeContextBar.configDir` if set, otherwise the `CLAUDE_CONFIG_DIR` environment variable, otherwise `~/.claude`. VS Code launched from the Start Menu or Finder often does not inherit shell-only env vars — use the setting in that case.

It resolves the context limit per model using this priority chain:

1. **User override** — the `modelContextLimits` setting (exact Model ID match). Highest priority, overrides everything below.
2. **200K models** — Haiku and legacy generations (Claude 3.x, Sonnet 4.5 and earlier, Opus 4.5 and earlier) resolve to 200,000 tokens.
3. **1M default** — every other current Claude model resolves to 1,000,000 tokens (Opus 4.6+, Sonnet 4.6+, Sonnet 5, Fable 5, and anything newer).
4. **Fallback** — unknown or non-Claude Model IDs use the `contextLimit` setting (default 200,000).

Claude session files record only the Model ID, with no context-window field, so the limit is inferred from the ID. The default is 1M because current frontier models all ship with a 1M window, which means new models resolve correctly with no update needed. Haiku and legacy models are the 200K exceptions. If any model is ever mis-sized (for example, your plan caps a model lower than its API window), pin an exact value in `modelContextLimits` and it always wins.

Context colors are driven by an absolute token count, not a percentage of the window. With context windows ranging from 200K to 1M, the same percentage stands for very different amounts of loaded context, and what degrades output quality is the absolute amount loaded — so `warningTokens` and `dangerTokens` mean the same thing whatever model a session runs on. The status bar shows that same consumed-token figure, so the number on screen is always the one that drives the color. The hover tooltip always shows both, plus the resolved window size. Subscription usage thresholds remain percentages, because that endpoint reports only a percentage.

Sessions inactive for more than 3 minutes (configurable via `idleTimeout`, `0` disables hiding) are automatically hidden, and reappear as soon as a resumed session writes new activity. The window regaining focus also triggers an immediate rescan. The extension also detects when sessions have been superseded by newer ones (e.g., after running `/clear` and opening a new tab), hiding ghost sessions immediately.

### Subscription usage

> **Experimental, off by default.** This feature relies on an undocumented Anthropic endpoint (the one Claude Code's own `/usage` command reads). Treat it as a temporary bonus: it may change or stop working at any time, entirely at Anthropic's discretion. Enable it with `claudeContextBar.showUsage: true`.

The context percentage is computed entirely from local files. The subscription usage (the `/usage` limits) is different: it is fetched from Claude's authenticated `GET /api/oauth/usage` endpoint, using the OAuth token that Claude Code stores in your OS credential store (macOS Keychain item `Claude Code-credentials`, or `<configDir>/.credentials.json` on Linux/Windows). This is the same data and the same mechanism Claude Code uses for its own `/usage` command; the token is used only as the request's `Authorization` header and is never logged or stored by the extension.

Usage is refreshed on its own cadence (`usageRefreshInterval`, default 60 seconds, independent of the context refresh) and the last known value is kept during transient failures. The endpoint rate-limits frequent polling, so avoid setting the interval very low. If you are not signed in with a Claude subscription (for example, using an API key), the usage item simply doesn't appear. Turn it off entirely with `showUsage`.

## License

MIT © 2025-2026 [Ed Zisk](https://github.com/edenaion)
