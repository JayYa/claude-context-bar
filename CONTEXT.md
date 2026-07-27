# Claude Context Bar

VS Code 扩展，实时监控 Claude Code 会话的上下文窗口使用量，在状态栏中以彩色进度指示器展示。

## Language

### 核心概念

**Session（会话）**：
Claude Code 的一次对话，持久化为一个 JSONL 文件。每个 VS Code 标签页各是一个独立 Session。
_Avoid_: Tab（标签页）—— Tab 是 VS Code UI 概念，Session 是领域概念。

**Project（项目）**：
Session 所属的工作目录/代码仓库。一个 Project 可以同时拥有多个 Session（多个 Claude Code 标签页指向同一项目）。
_Avoid_: Workspace（工作区）—— VS Code 有独立的 workspace 概念，容易混淆。

**Session File（会话文件）**：
Session 在磁盘上的持久化形式，路径为 `~/.claude/projects/<project>/<uuid>.jsonl`。代码中用作 Session 的唯一键（key）。
_Avoid_: JSONL file, log file

**Context Window Limit（上下文窗口上限）**：
一个 Session 可用的最大 token 容量。默认等于模型原生的上下文窗口大小（当前前沿模型为 1M，Haiku 及旧代模型为 200K），可由用户通过 `modelContextLimits` 配置按模型覆盖。解析优先级：用户覆盖 → 200K 模型列表 → 1M 默认 → 全局回退值。
_Avoid_: Context Window, Context Limit, Max Tokens

**Context Usage（上下文使用量）**：
当前 Session 已消耗的 token 总数，计算公式为 Input Tokens + Cache Read Tokens + Cache Creation Tokens。与 Context Window Limit 的比值即为状态栏显示的百分比。
_Avoid_: Token Count, Context Size

**Session Detection（会话检测）**：
扫描 `~/.claude/projects/` 目录，找出所有在当前 Idle Timeout 内有过修改的 Session File，并过滤掉 Ghost Session 的过程。由文件变更事件和定时轮询触发。
_Avoid_: Session Scan, Session Discovery

**Subscription Usage（订阅用量）**：
用户 Claude 订阅计划中的速率限制，包含 5 小时会话限额和周限额。由 Anthropic `/api/oauth/usage` 端点返回，与本地 Session File 无关。
_Avoid_: Usage, Rate Limits

**Subscription Usage Meter（订阅用量表）**：
单个速率限制维度的度量值，包含利用率百分比、重置时间、是否当前生效。示例：Session (5h) 73%、Weekly (Opus) 45%。
_Avoid_: Usage Meter, Rate Limit Bucket

### Session 生命周期

**Ghost Session（幽灵会话）**：
不应再在状态栏显示但可能残留的 Session 的总称。有两种成因。
_Avoid_: Dead Session, Stale Session

**Superseded Session（被取代的会话）**：
Ghost Session 的一种。当同 Project 下存在一个创建时间晚于本 Session 最后更新时间的更新 Session 时，本 Session 被视为被取代——用户已在新标签页中继续工作，旧标签页不再使用。
_Avoid_: Orphaned Session, Old Session

**Cleared Session（已清除的会话）**：
Ghost Session 的一种。用户执行了 `/clear` 命令且此后没有新的用户消息的 Session。`/clear` 重置了上下文，但文件仍留存。
_Avoid_: Reset Session

**Idle Timeout（空闲超时）**：
以秒计的时间阈值（默认 180 秒）。Session File 的最后修改时间若早于此阈值，则该 Session 被视为不活跃并被隐藏。用户可配置。
_Avoid_: Inactivity Period, TTL

### Token 子类型

**Input Tokens（输入令牌）**：
每次用户请求中新输入内容的 token 数量。
_Avoid_: New Tokens, Prompt Tokens

**Cache Read Tokens（缓存读取令牌）**：
从 Anthropic 提示缓存中命中并读取的 token 数量。这些 token 无需重新处理，可降低延迟和成本。
_Avoid_: Cached Input Tokens

**Cache Creation Tokens（缓存创建令牌）**：
为后续请求而写入缓存的 token 数量。写入后，相同前缀的后续请求可直接命中缓存。
_Avoid_: Cache Write Tokens

### UI 概念

**Status Bar Item（状态栏项）**：
扩展在 VS Code 状态栏右侧渲染的单个项目指示器。格式为 `{emoji} {projectName}: {percentage}%`，可点击隐藏，hover 时展示详细 tooltip。
_Avoid_: Indicator, Badge

**Warning Threshold（警告阈值）**：
Context Usage 百分比达到此值（默认 50%）时，Status Bar Item 的背景色变为黄色，提醒用户上下文用量偏高。用户可配置。
_Avoid_: Yellow Zone, Caution Threshold

**Danger Threshold（危险阈值）**：
Context Usage 百分比达到此值（默认 75%）时，Status Bar Item 的背景色变为红色，警告用户上下文即将耗尽。用户可配置。
_Avoid_: Red Zone, Critical Threshold
