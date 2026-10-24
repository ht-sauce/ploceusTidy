# docs/spec/INDEX.md · 络雀规范文集

> 编号文集的总目录。序号代表阅读先后，不代表重要性；未建篇目只在内容真正成规模时创建，不预先占位。

## 1. 文集地图

| 编号 | 文档 | 状态 | 内容 |
| --- | --- | --- | --- |
| — | [../REQUIREMENTS.md](../REQUIREMENTS.md) | 已建 | v1 需求基线、验收、非目标 |
| 00 | [00-overview.md](00-overview.md) | 已建 | 定位、核心流程、架构分层、质量属性、v1 范围 |
| 01 | [01-system-context.md](01-system-context.md) | 已建 | 用户、本机文件系统、Shell、剪贴板、dataWorkSpace、无云边界 |
| 02 | [02-client-architecture.md](02-client-architecture.md) | 已建 | Tauri/Rust/TS/Konva 分层、IPC、性能预算、源码规划 |
| 03 | [03-ui-interaction.md](03-ui-interaction.md) | 已建 | 窗口形态、顶栏搜索、卡片、画布交互、标注、设置 |
| 04 | [04-data-model.md](04-data-model.md) | 已建 | dataWorkSpace、SQLite 表、ID、去重、搜索、恢复 |
| 05 | [05-file-reference-contract.md](05-file-reference-contract.md) | 已建 | 只读引用、导入来源、路径规范化、打开/定位、缩略图、缺失 |
| 06 | [06-import-pipeline.md](06-import-pipeline.md) | 已建 | 拖入/粘贴、批量、去重、剪贴板、失败语义、性能 |
| 07 | [07-packaging.md](07-packaging.md) | 已建 | Tauri 打包、WebView2、安装形态、dataWorkSpace 默认路径 |
| 08 | [08-adr.md](08-adr.md) | 已建 | 架构决策记录、备选方案、待复核事项 |

## 2. 按角色阅读顺序

| 角色 / 场景 | 阅读顺序 |
| --- | --- |
| 新 AI 协作者、新成员 | `docs/README.md` → `docs/REQUIREMENTS.md` → 00 → 08 |
| 改画布 / 性能 | 00 → 02 → 03 → 08 的 ADR-005/008 |
| 改导入 / 文件引用 | 00 → 05 → 06 → 04 |
| 改数据模型 / 存储 | 04 → 05 → 08 的 ADR-003/006/007 |
| 改窗口 / 界面 | 03 → 02 §5 → 08 的 ADR-008/010 |
| 改高密度 / 系统图标 / 无边框 | 03 §1/§3/§4 → 08 ADR-010 → `client/components/TitleBar.tsx` / `FileTile.tsx` / `SystemIcon.tsx` |
| 改打包 / 安装 | 07 → 04 §1 → 08 的 ADR-001/003 |
| 查「为什么这么定」 | 08 的 ADR → 对应篇目的当前状态 |
| 查「能不能这么做」 | `docs/README.md` §3 硬约束清单（优先级最高） |

## 3. 维护契约（改动 → 必须同步）

| 场景 | 必须同步更新 |
| --- | --- |
| 新增 / 删除 model 或字段 | 04 + `project-overview.md` |
| 新增 / 变更引用、打开、定位、缺失语义 | 05 + `project-overview.md` |
| 新增 / 变更导入来源、批量、剪贴板、失败语义 | 06 + 05 |
| 新增模块 / 界面页面 / 配置项 | 02/03 对应章节 + `project-overview.md` |
| 窗口形态、渲染生命周期变化 | 03 + 02 §5 + 08 ADR-008 |
| 性能目标或画布渲染策略变化 | 02 §4/§9 + 08 ADR-005 |
| 打包、安装、dataWorkSpace 路径变化 | 07 + 04 §1 + 根 `README.md` + `AGENTS.md` 命令表 |
| 任何「二选一」的架构取舍 | 08 新增 ADR（含备选方案段） |
| ADR 引用的路径 / 名称 / 默认值过时 | 同批修正 ADR 事实（只改事实，不改决策） |
| 文件新增 / 删除 / 用途变化 | `project-overview.md`（每次例行同步） |
| 新增 / 改名项目专有名词 | `docs/GLOSSARY.md`【首个自造术语时建】 |
| 需求范围变化 | `REQUIREMENTS.md` + 00-overview §5 |
| 原型新增 / 定稿 / 归档 | `prototypes/README.md` + 03 §9 + `project-overview.md` |

## 4. 书写约定

- 正文一律简体中文；代码、字段名、命令保留原文。
- 图表统一 Mermaid，保证常见 Markdown 渲染器直接出图。
- **正文只写当前状态**：演进史进 ADR / 提交历史，不夹叙变更过程。
- **一条规则一个归属**：规则全文只写在归属文档，其他位置链接过去，禁止多处复述。
- **留结论删过程**：写决策、契约与理由，不写推导流水账。
- **段落克制**：一段只载一条规则；加粗只留给改变行为的条款。
- **禁止占位残留**：交付文档不得留「待补充 TODO」式占位；未决内容进 08 待复核清单。
- 文档表格手工对齐；配置格式化工具时把 `*.md` 加入忽略名单，避免中文表格被重排。
- **超预算三步**：入口或常驻文档超行数预算时——① 下沉到归属文档留链接 → ② 精简 → ③ 确需空间才提上限并在修订记录说明理由。
- 编号格式 `NN-主题.md`，序号代表阅读顺序；废弃编号不复用。

## 5. 增补规则

1. 先有内容再建篇：能写满一节可执行规则才建档，禁止空文件占位。
2. 新建篇目时同批更新：本文件 §1 状态、§2 阅读顺序、§3 维护契约。
3. 需求成规模时建立 `docs/REQUIREMENTS.md`，把范围与验收迁入，本文件登记。
4. 文档与代码不一致时：先报告用户裁决，不得静默采信任何一方（`docs/README.md` HC-3）。
