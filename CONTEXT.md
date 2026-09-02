# claude-context-bar

A VS Code status bar extension that surfaces live Claude Code state — per-project context window consumption and, optionally, subscription usage — without leaving the editor.

Terms are bilingual: the **English name is canonical** (it is what appears in the settings UI and in code); the Chinese是讨论时的对应说法，两者指同一个概念。

## Language

### Settings groups 设置分组

Every user-facing setting belongs to exactly one group. The group decides where the setting appears in the VS Code settings UI and in the README. When adding a setting, pick the group by asking what the setting *is about*, not what it technically controls.

每个面向用户的设置只属于一个分组。分组决定它在 VS Code 设置界面和 README 中的位置。新增设置时，按它*关乎什么*来归类，而不是按它技术上控制了什么。

**Appearance（外观）**:
Settings that change how a status bar item looks or reads — its icon, its color, the wording of the project name it displays.
状态栏条目的外观与读法：图标、颜色、项目名的写法。
_Avoid_: Display, UI, Style, Cosmetic / 显示、界面、样式、美化

**Context Window（上下文窗口）**:
Settings that define a model's context budget and the token counts at which consumption of that budget is called out as warning or danger.
定义模型的上下文预算，以及已用 token 达到多少时标记为警告或危险。
_Avoid_: Context, Limits, Tokens, Usage / 上下文、限额、令牌、用量

**Subscription Usage（订阅用量）**:
Settings governing the opt-in subscription usage item — whether it is shown at all, how often it is polled, and its own warning and danger thresholds. Distinct from Context Window: this is the account-level rolling session allowance, not a single conversation's token budget.
控制可选开启的订阅用量条目：是否显示、多久轮询一次、以及它自己的警告与危险阈值。与 Context Window 不同：这是账户级的滚动会话额度，不是单次对话的 token 预算。
_Avoid_: Usage, Quota, Limits, Plan / 用量、配额、限额、套餐

**Behavior（行为）**:
Settings that control when the extension acts and when a status bar item appears or disappears, independent of what any item looks like or measures.
控制扩展何时动作、条目何时出现或消失；与条目长什么样、量什么无关。
_Avoid_: Advanced, Misc, General, Timing / 高级、杂项、通用、计时

**Data Source（数据来源）**:
Settings that say where the extension reads its data from — which location on disk it looks in for Claude Code's own files. Distinct from Behavior: Behavior decides *when* the extension acts, Data Source decides *where* it reads from.
指明扩展从哪里读取数据：到磁盘上的哪个位置去找 Claude Code 自己的文件。与 Behavior 不同：Behavior 管*何时*动作，Data Source 管*从哪里*读。
_Avoid_: Path, Directory, Location, Advanced / 路径、目录、位置、高级

### Session concepts 会话概念

**Transcript（会话记录）**:
The value parsed out of one Claude Code session file: its token counts, model ID, opening user message, creation time, whether it ends on a `/clear`, and diagnostics about the parse itself (lines read, lines skipped as corrupt, where the `/clear` sat). A Transcript is what one file *says*, plus what reading it cost; it is not the account-level Subscription Usage, and it is not the file itself.
从单个 Claude Code 会话文件解析出来的值：token 数、模型 ID、首条用户消息、创建时间、是否以 `/clear` 收尾，以及本次解析的诊断信息（读了多少行、跳过多少坏行、`/clear` 在哪一行）。Transcript 是某个文件*说了什么*加上读它的代价，既不是账户级的 Subscription Usage，也不是文件本身。
_Avoid_: Usage, Session data / 用量、会话数据

**Active session（活跃会话）**:
A session the status bar shows. It has been touched recently enough to still count as in play, it carries tokens, and it has not been superseded. "Active" is a decision about display, not a claim that Claude is running right now.
状态栏会显示的会话：文件足够新、有 token 数、且没有被顶替。「活跃」是关于是否显示的判断，不代表此刻 Claude 正在运行。
_Avoid_: Live session, Open session, Current session / 实时会话、打开的会话、当前会话

**Superseded session（被顶替会话）**:
A session deliberately not shown even though its file is recent. One concept, two grounds: the session ended on a `/clear` with nothing after it, or a newer session in the same project was created after this one's last update — the user moved on. Both mean the same thing to the status bar, so do not name them separately.
明明文件很新、却被有意不显示的会话。一个概念、两条判据：会话以 `/clear` 收尾且其后再无内容，或同一项目下有更新的会话创建于本会话最后一次更新之后——用户已经走开了。对状态栏而言两者含义相同，不要分别命名。
_Avoid_: Ghost session, Dead session, Stale session, Abandoned session / 幽灵会话、僵尸会话、过期会话

### Related distinctions 易混概念

**Context limit（上下文额度）**:
The token budget available to a single Claude conversation. Belongs to Context Window.
单次 Claude 对话可用的 token 预算。归属 Context Window。
_Avoid_: Usage limit, Quota / 用量额度、配额

**Usage limit（用量额度）**:
The account's rolling subscription allowance, shared across all conversations. Belongs to Subscription Usage.
账户级的滚动订阅额度，所有对话共享。归属 Subscription Usage。
_Avoid_: Context limit, Rate limit / 上下文额度、速率限制

**Threshold unit（阈值单位）**:
The unit a warning or danger threshold is expressed in. Context Window thresholds are absolute **token counts** — a fixed amount of loaded context means the same thing whatever the model's window size, whereas a percentage does not. Subscription Usage thresholds are **percentages**, because the usage source reports only a percentage and never a token count. The two groups therefore carry similar-looking settings with different units; always name the unit when discussing a threshold.
阈值所用的单位。Context Window 的阈值是绝对 **token 数**——固定的上下文装载量在任何窗口大小下含义相同，而百分比不是。Subscription Usage 的阈值是**百分比**，因为用量来源只报百分比、从不给出 token 数。两组因此存在长得很像但单位不同的设置；讨论阈值时务必点明单位。
_Avoid_: Threshold percentage, Limit / 阈值百分比、限额
