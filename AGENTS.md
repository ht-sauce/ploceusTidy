# AGENTS.md · 络雀（ploceusTidy）

> 本地文件、文字与链接的空间索引画布。规则全文只存在于 `docs/`，本文件只做导航与硬边界提示，不复制规则。

## 1. 项目速览

| 项 | 当前值 |
| --- | --- |
| 产品名 | 络雀（仓库名 `ploceusTidy`） |
| 定位 | 把文件、截图、文字、URL 放到无限画布，分组、连线、标注、搜索定位；只存引用 |
| 形态 | A · 代码工程，Tauri 桌面客户端 |
| 技术栈 | Tauri 2 + Rust；React 19.3.1 + TypeScript 6.0.3；Ant Design 6.6.7；Vite 8.3.5；Konva 10 + react-konva + rbush（画布渲染层）；SQLite（rusqlite） |
| 持久化 | `dataWorkSpace/`：`ploceus.db` + `assets/` + `thumbnails/` + `logs/` |
| 外部数据源 | 纯本地；无云端、无遥测、无外部 API |
| 运行环境 | Windows 10/11 x64 桌面端；不含 iOS/Android；单机运行，不建端口表 |
| 当前阶段 | Konva 画布（rbush 视口裁剪 + 三档 LOD）、四套主题、分组框、连线标签/删除、缺失校验/重连、Shell 缩略图、工作空间打开/迁移/重建、`app_meta` 配置、`user_version` 迁移框架已实现；Rust 最小测试与 `check-spec` 已建；release exe 可启动，debug exe 被本机应用控制策略阻止（os error 4551），开发统一用 release 模式 |

## 2. 命令

> 前端脚手架与 Tauri 桌面壳已建立；新增后端命令或改变数据路径时，同批更新 `README.md` 与 `docs/project-overview.md`。

| 用途 | 命令 |
| --- | --- |
| 安装依赖 | `pnpm install` |
| 开发启动（浏览器原型） | `pnpm dev` |
| 开发启动（桌面客户端） | `pnpm tauri:dev`（release 模式） |
| 构建前端 | `pnpm build` |
| 构建桌面安装包 | `pnpm tauri:build` |
| 测试 | Rust：`cargo test --manifest-path desktop/Cargo.toml --lib` |
| 静态检查 | `pnpm lint` / `pnpm lint:fix` |
| 格式化 | `pnpm format` / `pnpm format:check` |
| 规范扫描（check-spec） | `pnpm check-spec`（`scripts/check-spec.mjs`） |

## 3. 目录速览

```text
ploceusTidy/
├── AGENTS.md                  # AI 入口（本文件）
├── README.md                  # 人类入口
├── package.json               # 前端依赖与命令
├── index.html                 # Vite 入口
├── vite.config.ts             # Vite + React 配置
├── tsconfig*.json             # TypeScript 配置
├── eslint.config.js           # ESLint flat config
├── prettier.config.cjs        # Prettier 配置
├── .editorconfig              # 编辑器基础约定
├── scripts/                  # check-spec.mjs 规范扫描
├── assets/                    # 品牌图
├── client/                    # React 前端与高密度画布
│   ├── main.tsx / App.tsx
│   ├── types/scene.ts
│   ├── lib/tauri-api.ts       # Tauri invoke 封装
│   ├── lib/theme.ts           # 四套主题语义令牌
│   ├── lib/search.ts          # 搜索归一化与排序
│   ├── components/            # TitleBar / CanvasBoard(Konva) / SystemIcon / DetailsPanel / SettingsDialog
│   └── styles/global.css
├── desktop/                   # Tauri 2 桌面壳与 Rust 平台层（仅桌面，无 iOS/Android）
│   ├── Cargo.toml / build.rs
│   ├── tauri.conf.json        # decorations:false、frontendDist ../client/dist
│   ├── capabilities/default.json
│   ├── icons/                 # 仅桌面图标
│   └── src/                   # main.rs / lib.rs / db.rs / models.rs / platform.rs
├── docs/
│   ├── README.md              # 规范入口：硬约束 + 工作流
│   ├── REQUIREMENTS.md        # v1 需求基线
│   ├── project-overview.md    # 文件级地图
│   ├── coding-conventions.md  # 编码约定
│   └── spec/                  # 00–08 规范文集
```

## 4. 接需求必读（强制第一步）

1. `docs/README.md` —— 硬约束清单与工作流。
2. `docs/coding-conventions.md` —— 编码约定。
3. `docs/REQUIREMENTS.md` —— 需求基线与验收。
4. 按任务范围加读 `docs/spec/00-overview.md`、`docs/spec/08-adr.md`。
5. 用 `docs/project-overview.md` 定位文件，只精读目标文件；禁止全量扫描。

单行 typo / 单行 bug 可简化流程，但仍须遵守硬约束。

## 5. 硬边界（违反会直接出问题，全文见 `docs/README.md` §3）

- NEVER 未读 `docs/README.md` 就改动文件。
- NEVER 修改、移动、重命名、删除用户文件；络雀只读引用。
- NEVER 让读取、打开、定位越出用户显式导入的引用；解析真实路径后校验，不跟随符号链接越界。
- NEVER 将文件内容或元数据发往本机之外；URL 只交给系统浏览器。
- NEVER 静默跳过失败文件；失败必须带路径与原因上报。
- NEVER 用自增 ID 作为表关联键。
- NEVER 在不可见窗口或离屏区域持续渲染；渲染必须按需。
- NEVER 生成或保留 iOS/Android 产物；这是纯桌面客户端。
- NEVER M0 剪贴板/画布 spike 未过就写 Tauri 业务代码；前端 UX 原型与工具链可先行。
- NEVER 边读边改、边对话边改；方案确认后一次性批量改动。
- NEVER 单条命令阻塞超过 5 分钟仍死等；必须中断，改用非阻塞执行、缩小范围或拆分验证。
- NEVER 未经明确要求执行 `git commit` / `git push`。

## 6. 文档索引

| 文档 | 用途 |
| --- | --- |
| [docs/README.md](docs/README.md) | ★ 规范入口：必读流程、硬约束、工作流 |
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | v1 需求基线、验收、非目标 |
| [docs/project-overview.md](docs/project-overview.md) | 技术栈现状 + 文件级职责地图 |
| [docs/coding-conventions.md](docs/coding-conventions.md) | 技术栈无关的编码约定与待补项 |
| [docs/spec/INDEX.md](docs/spec/INDEX.md) | 文集地图、阅读顺序、维护契约、书写约定 |
| [docs/spec/00-overview.md](docs/spec/00-overview.md) | 定位、架构分层、质量属性、v1 范围 |
| [docs/spec/02-client-architecture.md](docs/spec/02-client-architecture.md) | Tauri/Rust/React/Ant Design/Konva 分层、IPC、性能 |
| [docs/spec/03-ui-interaction.md](docs/spec/03-ui-interaction.md) | 无边框窗口、高密度桌面图标网格、分组布局、语义色主题、搜索、画布交互 |
| [docs/spec/04-data-model.md](docs/spec/04-data-model.md) | dataWorkSpace、SQLite 表、ID、去重 |
| [docs/spec/05-file-reference-contract.md](docs/spec/05-file-reference-contract.md) | 只读引用、打开/定位、缩略图、缺失 |
| [docs/spec/06-import-pipeline.md](docs/spec/06-import-pipeline.md) | 拖入/粘贴、批量、去重、失败 |
| [docs/spec/07-packaging.md](docs/spec/07-packaging.md) | Tauri 打包、WebView2、安装与数据路径 |
| [docs/spec/08-adr.md](docs/spec/08-adr.md) | 架构决策记录与待复核事项 |

## 7. 待复核事项（不得擅自拍板）

| 事项 | 触发时机 | 说明 |
| --- | --- | --- |
| Tauri 剪贴板文件路径 spike | M0 | `clipboard-win::raw::get_file_list` 在目标 Windows 验证；失败则补 `CF_HDROP` 直读 |
| 1 万 / 10 万画布基准 | M2 / M4 | 验证视口裁剪、LOD、空间索引、缩略图节流 |
| 搜索索引升级 | 5 万引用后 | `LIKE` → FTS5 trigram / 内存索引 |
| 多画布 | v2 评估 | 当前单画布 + 分组框 |
| macOS/Linux | 后续 | 剪贴板、Shell 缩略图、打包分别补平台实现 |

决策一经确认，按 `docs/spec/08-adr.md` 补 ADR，并同批补齐命令表、工程结构与领域规范。
