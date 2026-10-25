# AGENTS.md · 络雀（ploceusTidy）

> 本地文件、文字与链接的空间索引画布。规则全文只存在于 `docs/`，本文件只做导航与硬边界提示，不复制规则。

## 1. 项目速览

| 项 | 当前值 |
| --- | --- |
| 产品名 | 络雀（仓库名 `ploceusTidy`） |
| 定位 | 把文件、截图、文字、URL 放到无限画布，分组、连线、标注、搜索定位；只存引用 |
| 形态 | A · 代码工程，Tauri 桌面客户端 |
| 技术栈 | Tauri 2 + Rust；React 19.3.1 + TypeScript 6.0.3；Ant Design 6.6.7；Vite 8.3.5；Konva 10 + react-konva + rbush（画布渲染层）；pinyin-pro（搜索首字母）；SQLite（rusqlite） |
| 持久化 | `dataWorkSpace/`：`ploceus.db` + `assets/` + `thumbnails/` |
| 外部数据源 | 纯本地；无云端、无遥测、无外部 API |
| 运行环境 | Windows 10/11 x64 桌面端；不含 iOS/Android；单机运行，不建端口表 |
| 当前阶段 | Konva 画布（rbush 视口裁剪含连线 + 高清倍率，不做远景 LOD）、四套主题、统一拖动行为（拖动期不校验碰撞、rbush 局部对齐吸附、松手判定落点；>2000 选中降级为包围盒 ghost）、空间（成员自动归属/随成员自动扩缩/可拖动/可连线/标题即标注/可改色/选中发光/右键自动整理）、不重叠、连线标签颜色与选中发光、原生 Shell 右键菜单、缺失校验/重连、Shell 缩略图与快捷方式图标（无内置预览与视频封面，图片/视频系统打开）、右键菜单与关联跳转、工作空间打开/迁移/重建、`app_meta` 配置、`user_version` 迁移框架、搜索（对象/标注/空间/连线 + 拼音首字母 + top-9 线性选择）、最小化暂停渲染、SQLite 读写分离连接 + 指纹增量写库 + 引用级 diff 增量传输（每 20 次全量对账）+ 保存序列化 Worker + 重命令异步化（主线程不等数据库）、Minimap 单 canvas、构建手动分包 + antd 按需引入（首屏主脚本约 310KB）已实现；Rust 最小测试与 `check-spec` 已建；release exe 可启动，debug exe 被本机应用控制策略阻止（os error 4551），开发统一用 release 模式 |

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
├── vite.config.ts             # Vite + React 配置（root: client）
├── tsconfig*.json             # TypeScript 配置
├── eslint.config.js           # ESLint flat config
├── prettier.config.cjs        # Prettier 配置
├── .editorconfig              # 编辑器基础约定
├── scripts/                  # check-spec.mjs 规范扫描
├── assets/                    # 品牌图
├── client/                    # React 前端与高密度画布
│   ├── index.html             # Vite 入口
│   ├── main.tsx / App.tsx     # App 仅入口：主题状态 + ConfigProvider → Workspace
│   ├── types/scene.ts
│   ├── lib/tauri-api.ts       # Tauri invoke 封装；sceneSerialize.worker.ts 负责保存序列化
│   ├── lib/theme.ts           # 四套主题语义令牌
│   ├── domain/                # 领域纯函数：layout（碰撞/吸附/空位/整理/贴合）+ search（归一化/拼音/排序）
│   ├── workspace/             # 编排层：useSceneStore / useScenePersistence / useImportClipboard
│   │                          #        / useNodeActions / useContextMenu / useShortcuts / useSearch
│   │                          #        / useWindowSuspended / Workspace
│   ├── canvas/                # 画布层：CanvasBoard（图层编排）+ useCanvasViewport（视口）
│   │                          #        + useVisibleScene（裁剪/连线筛选）+ useCanvasInteractions（交互会话）
│   │                          #        + useVisibleThumbnails + NodeShape / GroupShape / EdgeLayer / Minimap
│   │                          #        + CanvasTextEditor / geometry / icons / constants / types
│   ├── components/            # 通用组件：TitleBar / SystemIcon / DetailsPanel / ContextMenu
│   │                          #        / StatusBar / EmptyOverlay / TextPromptDialog / ColorPickerDialog
│   │                          #        / NeighborPickerDialog / SettingsDialog
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
| Tauri 剪贴板文件路径 | 已完成 | Windows `CF_HDROP` 可用；macOS NSPasteboard、Linux wl-paste/xclip 已有实现 |
| 1 万 / 10 万画布基准 | 已完成 | 已实测（数字为性能优化前测得）；需要新数字时用 `PLOCEUS_BENCH_SEED` 重测 |
| 搜索索引升级 | 5 万引用后 | `LIKE` → FTS5 trigram / 内存索引 |
| 百万级画布 | 有真实需求时 | 渲染已与总量无关；需增量索引更新与增量写库 |
| 多画布 | v2 评估 | 当前单画布 + 空间（分组框） |
| macOS/Linux | 后续 | 剪贴板已有；Shell 缩略图降级；打包（dmg/AppImage/deb）与真机验证未做 |
| 代码签名 | 已完成（v0.1.0） | 自签名证书已签名并发布 v0.1.0；正式 CA 证书待评估 |

决策一经确认，按 `docs/spec/08-adr.md` 补 ADR，并同批补齐命令表、工程结构与领域规范。
