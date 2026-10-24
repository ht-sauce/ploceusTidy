﻿# coding-conventions.md · 络雀编码约定

> 技术栈已定：Tauri 2 + Rust；React 19.3.1 + TypeScript 6.0.3；Ant Design 6.6.7；Vite 8.3.5；Konva（M2 渲染层）；SQLite。本文件固化与技术栈无关的约定与工具链约定。

## 1. 语言与类型

- 采用严格类型检查；能静态约束的不用运行时兜底。
- 本项目使用 TypeScript：禁止 `any`（用 `unknown` + 类型守卫）；纯类型导入用 `import type`；`catch (e: unknown)` 后再收窄。
- 接口 / 数据结构必须显式声明类型，禁止靠推断传递跨层数据。
- 校验只在边界处（用户输入、文件系统返回、外部 API）；内部模块互信，不做冗余校验。

## 2. 命名

| 对象 | 规则 | 示例 |
| --- | --- | --- |
| 变量 / 函数 | camelCase | `locateNode` |
| 类型 / React 组件 | PascalCase | `FileTile` / `SceneNode` |
| TS 模块 / 规则文件 | kebab-case | `mock-scene.ts` / `search-results` |
| 常量 | UPPER_SNAKE_CASE | `MAX_NODE_COUNT` / `DEFAULT_ZOOM` |
| 环境变量 | 全大写下划线 | `DATA_WORKSPACE_PATH` |
| 数据结构主键 / 关联键 | 自定义 ID | `nodeId` / `refId`，禁止依赖自增 |

- 命名表达职责而非实现：`locateNode` 优于 `doLocate2`。
- 同一概念全仓库同名，禁止「引用 / 卡片 / node / card」混用（术语统一见 [spec/00-overview.md](spec/00-overview.md)）。

## 3. 注释

### 3.1 基本规则

- 一律简体中文；标识符、命令、协议字段保留原文。
- 只解释「为什么」与边界，不复述「做什么」；自明代码不加注释。
- 注释与代码同批维护：改逻辑必须同步改注释，过期注释按缺陷处理。
- 禁止 `TODO` / `FIXME` / `// removed ...` 占位注释：要么现在做，要么写进待决清单，要么不留。

### 3.2 必须写注释的位置

| 位置 | 要求 |
| --- | --- |
| 文件顶部 | 一句话职责 + 关键边界；TS/TSX 用 `/** ... */`，Rust 用 `//!` |
| 导出函数 / Tauri 命令 / 类型 | 意图、参数与返回语义、失败条件；Rust 用 `///` 文档注释 |
| 复杂算法与坐标变换 | 说明坐标系、单位、方向；如 world ↔ screen 的变换公式 |
| 魔法数值 | 说明来源与后果；如 LOD 阈值 50%、预取边距 180px |
| 非显然的状态 / ref / 平台处理 | 说明它解决的具体问题；如指针捕获后为什么需要 `pressedOnNode` |
| 大文件分段 | 用 `// ---------- 段落名 ----------` 分隔职责区，段落不超过约 150 行 |
| 权限、平台差异、回退路径 | 说明为什么需要该权限或为什么只能这样回退 |

### 3.3 反例

- `// 设置状态`、`// 遍历数组`：复述代码，删除。
- `// 修改于 2026-10`：变更历史进 git / ADR，不写在代码里。
- 大段被注释掉的旧实现：直接删除，需要时从 git 找回。

## 4. 错误处理

- 文件操作错误必须携带「路径 + 操作 + 原因」三层信息，并按 HC-14 呈现给用户。
- 禁止空 `catch`、禁止只打日志不返回；失败要么重试（幂等前提下），要么上报。
- 用户可见错误用业务语言描述后果与下一步，不直接抛原始堆栈。

## 5. 批量任务与长任务

- 批量导入、缩略图生成、工作空间迁移等任务必须提供：进度（已处理 / 总数）、当前项、可取消。
- 批量导入前显示文件数量与来源；失败项汇总，不允许静默跳过（HC-14）。
- 工作空间迁移先复制到新位置并校验，成功后再切换；失败保留旧目录，不允许半成品切换。
- 取消或中断后必须保持状态一致：数据库事务回滚，或明确标记「部分完成」，不允许静默半成品。

## 6. 文件创建纪律

- 优先改已有文件；确需新建时才新建，并在同一批改动中更新 `project-overview.md`。
- 临时调试脚本文件名以 `_` 开头（如 `_import-debug`），不入主流程，提交前删除。
- 不建空文件、空目录、空占位章节。

## 7. 缺陷修复三段式

修 Bug 前先用三行写清边界，防止「修好 A 顺手弄坏 B」：

```text
现状：WHEN 拖入 3000 个文件 THEN 画布逐张生成缩略图并卡死（缺陷）
期望：WHEN 批量导入 THEN 只入库引用，缩略图进入可见区域后异步加载（修复目标）
回归护栏：WHEN 画布隐藏/最小化 THEN 停止 RAF 与缩略图请求，恢复后继续（不可破坏的既有行为）
```

判断规则：这次修复**可能波及什么**，就为它写护栏；导入、画布渲染、引用打开类修复必须覆盖「重复定位 / 缺失 / 不可见暂停」三条路径。

## 8. 技术栈落地约定

| 项 | 当前结论 | 归属 |
| --- | --- | --- |
| 框架与目录结构 | Tauri 2 + React 19.3.1 + TS；`desktop/`（已建）+ `client/`（已建） | [spec/02-client-architecture.md](spec/02-client-architecture.md) §7 |
| 进程 / 通信约定 | Tauri `invoke`；前端不直接访问文件系统/数据库 | 同上 §6 |
| 数据模型与迁移 | SQLite + `dataWorkSpace`；`PRAGMA user_version` 迁移 | [spec/04-data-model.md](spec/04-data-model.md) |
| 文件引用契约 | 只读引用；打开/定位只接受 `refId` | [spec/05-file-reference-contract.md](spec/05-file-reference-contract.md) |
| 画布与性能 | 当前客户端：React DOM 虚拟行；生产：Konva 虚拟化 + rbush + 三档 LOD | 02 §4、[08-adr.md](spec/08-adr.md) ADR-005 |
| 格式化工具与配置 | `prettier.config.cjs`：`printWidth: 100`、`semi: false`、`tabWidth: 2`、`useTabs: false`、`singleQuote: true`、`trailingComma: 'all'`、`endOfLine: 'auto'` | 本文件 |
| ESLint | `eslint.config.js` flat config：`@eslint/js`、`typescript-eslint`、`react-hooks`、`react-refresh`、`eslint-config-prettier` | 本文件 |
| 编辑器基础 | `.editorconfig`：UTF-8、LF、2 空格、文件末尾换行 | 本文件 |
| 依赖版本 | 精确锁定最新稳定版；不使用 `latest` 标签或测试版；TypeScript 使用 6.0.3（`typescript-eslint` 兼容上限 <6.1.0） | `package.json` + `pnpm-lock.yaml` |
| lint / 构建 / 测试命令 | `pnpm lint` / `pnpm build`；测试 M1 补 | `AGENTS.md` §2 + 根 `README.md` |
