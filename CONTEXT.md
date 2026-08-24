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
Settings that define a model's context budget and the thresholds at which consumption of that budget is called out as warning or danger.
定义模型的上下文预算，以及消耗到多少时标记为警告或危险。
_Avoid_: Context, Limits, Tokens, Usage / 上下文、限额、令牌、用量

**Subscription Usage（订阅用量）**:
Settings governing the opt-in subscription usage item — whether it is shown at all, how often it is polled, and its own warning and danger thresholds. Distinct from Context Window: this is the account-level rolling session allowance, not a single conversation's token budget.
控制可选开启的订阅用量条目：是否显示、多久轮询一次、以及它自己的警告与危险阈值。与 Context Window 不同：这是账户级的滚动会话额度，不是单次对话的 token 预算。
_Avoid_: Usage, Quota, Limits, Plan / 用量、配额、限额、套餐

**Behavior（行为）**:
Settings that control when the extension acts and when a status bar item appears or disappears, independent of what any item looks like or measures.
控制扩展何时动作、条目何时出现或消失；与条目长什么样、量什么无关。
_Avoid_: Advanced, Misc, General, Timing / 高级、杂项、通用、计时

### Related distinctions 易混概念

**Context limit（上下文额度）**:
The token budget available to a single Claude conversation. Belongs to Context Window.
单次 Claude 对话可用的 token 预算。归属 Context Window。
_Avoid_: Usage limit, Quota / 用量额度、配额

**Usage limit（用量额度）**:
The account's rolling subscription allowance, shared across all conversations. Belongs to Subscription Usage.
账户级的滚动订阅额度，所有对话共享。归属 Subscription Usage。
_Avoid_: Context limit, Rate limit / 上下文额度、速率限制
