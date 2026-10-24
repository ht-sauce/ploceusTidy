# project-overview.md · 络雀文件地图

> 定位文件的第一入口：先查本表，再精读目标文件。新增 / 删除 / 改用途的文件必须在同一批改动中同步此表（HC-3）。

## 1. 技术栈现状

| 维度 | 当前结论 | 说明 |
| --- | --- | --- |
| 运行形态 | Windows 桌面客户端 | 纯电脑端，不含 iOS/Android |
| 框架 / 语言 | Tauri 2 + Rust；React 19.3.1 + TypeScript 6.0.3 | 见 ADR-001 |
| 工程结构 | 单体单应用：`desktop/`（Rust/Tauri）+ `client/`（React） | 见 ADR-002 |
| UI 组件 | Ant Design 6.6.7 + `@ant-design/icons` 6.3.4 | 见 02 §8 |
| 构建 | Vite 8.3.5 + `@vitejs/plugin-react` 6.1.2 | `vite.config.ts` |
| 画布 | Konva 10 + react-konva 19.3.2 + rbush 4，三档 LOD + 视口裁剪 | 见 ADR-005、02 §4 |
| 主题 | 四套浅色主题语义令牌（`client/lib/theme.ts` + CSS 变量 + AntD ConfigProvider） | 见 ADR-014、03 §10 |
| 数据存储 | SQLite（rusqlite）+ `dataWorkSpace`；`PRAGMA user_version` 迁移 | 见 ADR-003 与 [04-data-model.md](spec/04-data-model.md) |
| 外部数据源 | 纯本地，无云端、无遥测 | 见 ADR-004 |
| 构建 / 测试命令 | `pnpm build` / `pnpm lint` / `pnpm check-spec`；Rust `cargo test --manifest-path desktop/Cargo.toml --lib`；桌面端 `pnpm tauri:dev`（release）/ `pnpm tauri:build` | —— |
| 当前运行状态 | release exe 已构建并可启动；debug exe 被 Windows 应用控制策略阻止（os error 4551） | `pnpm tauri:dev` 固定 release 模式 |

## 2. 文件级目录地图

```text
ploceusTidy/
├── AGENTS.md                       # AI 协作入口
├── README.md                       # 人类入口
├── package.json                    # 前端/Tauri 依赖与脚本
├── pnpm-lock.yaml
├── scripts/
│   └── check-spec.mjs             # 硬约束静态扫描（pnpm check-spec）
├── vite.config.ts                  # root: client，127.0.0.1:5173
├── tsconfig.json / tsconfig.app.json / tsconfig.node.json
├── eslint.config.js / prettier.config.cjs / .editorconfig
├── .prettierignore / .gitignore
├── assets/
│   └── ploceusTidy.jpg             # 品牌图
├── client/                         # React 前端
│   ├── index.html                  # Vite 入口
│   ├── main.tsx                    # React 入口、Ant Design ConfigProvider / App
│   ├── App.tsx                     # 场景状态、Tauri 加载/保存、拖入/粘贴、搜索、标注
│   ├── vite-env.d.ts
│   ├── lib/
│   │   ├── tauri-api.ts            # invoke 封装、isTauri
│   │   ├── theme.ts                # 四套主题令牌与 applyTheme/normalizeTheme
│   │   └── search.ts               # 搜索归一化与排序分级
│   ├── types/
│   │   └── scene.ts                # SceneNode / SceneGroup / SceneEdge / 标注 / IPC DTO
│   ├── data/
│   │   └── mock-scene.ts           # 浏览器原型的 1600 条模拟引用（72×64 网格）
│   ├── components/
│   │   ├── TitleBar.tsx            # 无边框标题栏：搜索、新建文字、设置、窗口按钮
│   │   ├── CanvasBoard.tsx         # Konva 画布：视口、rbush 裁剪、LOD、分组、连线、迷你地图
│   │   ├── SystemIcon.tsx          # 文件夹 / PDF / Word / Excel / DWG / EXE / 图片 / 视频 / TXT / 链接
│   │   ├── DetailsPanel.tsx        # 引用详情（含缺失徽标与重新关联）与标注编辑
│   │   ├── TextEditorDialog.tsx    # 文字卡编辑弹窗
│   │   ├── ImagePreviewDialog.tsx  # Ant Design 图片预览
│   │   └── SettingsDialog.tsx      # 外观主题 / 工作空间 / 窗口 / 数据 / 关于
│   └── styles/global.css
├── desktop/                        # Tauri 2 桌面壳 / Rust 平台层（无移动端）
│   ├── Cargo.toml / Cargo.lock / build.rs
│   ├── tauri.conf.json             # decorations:false 无边框自定义标题栏、frontendDist ../client/dist、仅 nsis
│   ├── capabilities/default.json   # core / opener / dialog 权限
│   ├── icons/                      # 仅桌面图标
│   └── src/
│       ├── main.rs / lib.rs        # Tauri 启动、命令注册
│       ├── db.rs                   # dataWorkSpace、迁移、场景加载/增量保存、导入去重、校验/重连、缩略图、app_meta
│       ├── models.rs               # IPC DTO
│       └── platform.rs             # 路径规范化、文件类型、剪贴板文件、Shell 缩略图、窗口置底
├── docs/
│   ├── README.md / REQUIREMENTS.md / project-overview.md / coding-conventions.md
│   └── spec/                       # 00–08
└── dataWorkSpace/                  # 运行时生成，不入库
```

## 3. 规划但未创建

```text
client/
├── domain/            # 纯 TS：实体、命令、撤销、定位编排
└── shared/            # 更完整的 IPC 契约与共享类型
```

- 画布渲染已切换到 Konva（`CanvasBoard.tsx`），场景模型与渲染层解耦，替换渲染器不影响业务命令。
- 领域层 `client/domain` 尚未抽离：实体逻辑目前在 `App.tsx`，抽离前不得再往组件里堆业务规则。

## 4. 功能域 → 文件速查

| 想知道什么 | 看哪里 |
| --- | --- |
| 能不能这么做 / 红线 | `docs/README.md` §3 硬约束清单 |
| v1 做什么 / 验收 | `docs/REQUIREMENTS.md` |
| 产品定位、架构总纲 | `docs/spec/00-overview.md` |
| 技术选型与历史决策 | `docs/spec/08-adr.md` |
| 窗口形态、高密度 UI、系统图标 | `desktop/tauri.conf.json`、`client/components/TitleBar.tsx`、`CanvasBoard.tsx`、`SystemIcon.tsx`、`docs/spec/03-ui-interaction.md` |
| 画布平移缩放、Konva 渲染、LOD、迷你地图 | `client/components/CanvasBoard.tsx`、`docs/spec/02-client-architecture.md` §4 |
| 主题切换与语义令牌 | `client/lib/theme.ts`、`client/styles/global.css`、`docs/spec/03-ui-interaction.md` §10 |
| 搜索归一化与排序 | `client/lib/search.ts`、`client/App.tsx` |
| Tauri 命令、SQLite、导入去重 | `desktop/src/lib.rs`、`db.rs`、`models.rs`、`platform.rs` |
| 拖入 / 粘贴 / 打开 / 定位 | `client/App.tsx`、`client/lib/tauri-api.ts` |
| 搜索、标注、设置 | `client/App.tsx`、`TitleBar.tsx`、`DetailsPanel.tsx`、`SettingsDialog.tsx` |
| 模拟数据与场景模型 | `client/data/mock-scene.ts`、`client/types/scene.ts` |
| 表结构、dataWorkSpace、ID | `docs/spec/04-data-model.md` |
| 文件打开/定位、缩略图、缺失 | `docs/spec/05-file-reference-contract.md` |
| 拖入/粘贴/去重/失败语义 | `docs/spec/06-import-pipeline.md` |
| 安装包、WebView2、数据路径 | `docs/spec/07-packaging.md` |
| 命名、注释、错误处理、工具链 | `docs/coding-conventions.md` |

## 5. 待补地图项

- 视频封面、图片预览协议。
- `client/domain`、`client/shared` 的实际文件与职责。
- 1 万 / 10 万画布基准实测（Konva + rbush 已就位，需真实数据验证）。
- NSIS 安装包验收（WebView2、数据路径、体积）。
