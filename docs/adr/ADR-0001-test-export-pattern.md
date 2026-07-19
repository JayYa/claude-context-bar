# ADR-0001: `_test` 命名空间——模块私有函数的测试导出模式

**日期**：2026-07-19  
**状态**：已接受  
**决策者**：架构审查 grilling 环节

## 背景

项目经历多次模块提取（`sessionFile`、`sessionDetection`、`statusBarManager`），纯函数被直接 `export` 以便单元测试。当前有 ~12 个函数标注为 "exported for testing"，包括：

- `sessionFile.ts`：`decodeProjectPath`（公开接口，保留）
- `sessionDetection.ts`：`processSessionGroups`、`creationTime`
- `statusBarManager.ts`：`getEmojiForProject`、`extractLastSyllable`、`getShortName`、`formatTokens`、`buildSessionText`、`getBackgroundColorId`、`buildTooltip`、`assignProjectColors`、`filterHiddenSessions`

这些函数并非模块对外接口的一部分——它们纯粹是实现细节。直接 `export` 使公共接口膨胀，并暗示其他模块可以合法依赖它们。

## 决策

采用 `_test` 命名空间对象作为统一的测试导出模式：

```typescript
// 模块私有函数 —— 不对外导出
function findLastClearIndex(lines: string[]): number { /* ... */ }

// 测试导出 —— 仅供测试访问
export const _test = {
    findLastClearIndex,
    // ...
};
```

测试中通过 `_test.xxx()` 访问：

```typescript
import { _test } from './sessionFile';
const { findLastClearIndex } = _test;
```

## 规则

| 规则 | 说明 |
|------|------|
| `_test` 中只放纯函数 | 不接受依赖注入、不产生副作用——只暴露 compute/logic 函数 |
| 公开接口函数不入 `_test` | 如果函数已被其他模块 import，则保持公开导出 |
| 函数前加简短注释 | `// Exported via _test for testing` |
| 测试中解构后使用 | `const { fn } = _test;` ——与直接 import 有相同的可读性 |

## 后果

### 正面

- **接口缩小**：模块的公共 interface 不再被测试需求撑大。caller 能明确区分"你应该用的"和"仅供测试的"
- **locality**：新的内部 seam 化（如 `getLatestTokenCount` 的拆分）有明确的导出路径，不需要每次重新决策
- **leverage**：一个模式覆盖所有模块的测试导出需求——降低认知开销

### 负面

- 测试中需要使用 `_test.xxx()` 而非直接 `import { xxx }`，多一次解构
- 需要一次性迁移 12 个现有导出（3 个模块）——迁移成本集中在初次

## 替代方案

### 方案 B：直接 export 标注注释（现有做法）

当前做法：`export function processSessionGroups(...)` + 注释 `// EXPORTED FOR TESTING`。

- **优点**：简单，无需额外对象
- **缺点**：无法阻止其他模块导入；IDE 自动补全建议中包含内部函数；随规模增长接口膨胀不可逆

### 方案 C：TypeScript `namespace`

```typescript
export namespace _test { export const fn = _fn; }
```

- **优点**：与 ES module 语义集成更好
- **缺点**：增加语言特性依赖；与 CommonJS 互操作不如对象字面量

**选择方案 A**（`_test` 对象字面量）：最简、最明确、与 CommonJS 兼容最好。TypeScript 的 `namespace` 在此场景下没有额外收益。

## 迁移计划

1. `sessionFile.ts`：新增 6 个 `_test` 函数，保留 `decodeProjectPath` 为公开 export（被 `sessionDetection.ts` 使用）
2. `sessionDetection.ts`：`processSessionGroups` 从公开 export 移入 `_test`
3. `statusBarManager.ts`：9 个纯函数从公开 export 移入 `_test`
4. 对应测试文件同步更新 import
