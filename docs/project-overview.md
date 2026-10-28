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
| 画布 | Konva 10 + react-konva 19.3.2 + rbush 4，视口裁剪 + 高清倍率（不做远景 LOD） | 见 ADR-005 / ADR-016、02 §4 |
| 主题 | 四套浅色主题语义令牌（`client/lib/theme.ts` + CSS 变量 + AntD ConfigProvider） | 见 ADR-014、03 §10 |
| 富文本 | `@wangeditor-next/editor` 6.5.1（按需加载的懒 chunk），正文 HTML 存 `nodes.body`，媒体引用存 `assets/<文件名>` 相对路径 | 见 ADR-025、ADR-029 |
| 搜索 | 内存子串 + 拼音首字母（`pinyin-pro`），覆盖对象、标注、空间与连线标签 | 见 ADR-020 |
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
│   ├── check-spec.mjs             # 硬约束静态扫描（pnpm check-spec；含版本号一致性与发布日志条目）
│   ├── bump-version.mjs           # 版本号提升：同步四处副本（pnpm version:bump）
│   └── collect-installer.mjs      # 只收集当前版本的 NSIS 安装包到 release/（tauri:build 后自动执行）
├── vitest.config.ts                # 前端单测配置（client/**/*.test.ts，别名 @）
├── release/                        # 安装包固定产物地址（入库，README 直链下载）
├── vite.config.ts                  # root: client，127.0.0.1:5173
├── tsconfig.json / tsconfig.app.json / tsconfig.node.json
├── eslint.config.js / prettier.config.cjs / .editorconfig
├── pnpm-workspace.yaml             # pnpm 12 设置（依赖构建脚本白名单 allowBuilds）
├── .prettierignore / .gitignore
├── assets/
│   └── ploceusTidy.jpg             # 品牌图
├── client/                         # React 前端
│   ├── index.html                  # Vite 入口
│   ├── main.tsx                    # React 挂载
│   ├── App.tsx                     # 入口壳：仅主题状态 + Ant Design 容器
│   ├── vite-env.d.ts
│   ├── lib/
│   │   ├── tauri-api.ts            # invoke 封装、isTauri；保存序列化走 sceneSerialize Worker
│   │   ├── sceneSerialize.worker.ts # 场景 JSON 序列化 Worker（stringify 出主线程）
│   │   └── theme.ts                # 四套主题令牌与 applyTheme/normalizeTheme
│   ├── domain/                     # 领域纯函数（布局与搜索，不依赖 React/Konva）
│   │   ├── layout.ts               # 矩形碰撞、吸附参考线、空位查找、空间自动整理/贴合/折叠显示框
│   │   ├── layout.test.ts          # 布局用例（碰撞、吸附、避让、贴合、整理、折叠）
│   │   ├── search.ts               # 搜索归一化、拼音首字母缓存与分级排序
│   │   └── search.test.ts          # 搜索用例（归一化、拼音、分级排序）
│   ├── types/
│   │   └── scene.ts                # SceneNode / SceneGroup / SceneEdge / 标注 / IPC DTO
│   ├── workspace/                  # 业务编排层（场景命令、持久化、快捷键、菜单）
│   │   ├── Workspace.tsx           # 组合画布/标题栏/属性面板/状态栏/弹窗
│   │   ├── useSceneStore.ts        # 场景数据 + 选择 + 撤销/重做栈 + 方向键微调 + 删除/标注/空间命令（含手动调框、进出空间整理）；媒体正文无文字时仍可保存
│   │   ├── useScenePersistence.ts  # 加载/防抖保存/flush/关窗先落库/保存状态订阅/缺失校验/拖入监听
│   │   ├── useImportClipboard.ts   # 文件导入、文字/链接/截图落盘与粘贴；失败项交给界面层汇总
│   │   ├── useNodeActions.ts       # 打开、定位、重连、双击激活
│   │   ├── useContextMenu.ts       # 右键菜单状态、条目与动作（含系统菜单入口）
│   │   ├── useShortcuts.ts         # 全局快捷键映射（含 Ctrl+S 保存、撤销/重做、方向键微调）
│   │   ├── useWindowSuspended.ts   # 最小化/隐藏检测，驱动暂停渲染
│   │   └── useSearch.ts            # 搜索条目（对象/标注/空间/连线）与排序
│   ├── canvas/                     # 画布域（Konva 渲染与交互）
│   │   ├── CanvasBoard.tsx         # 图层编排：组合视口/可见性/交互会话
│   │   ├── useCanvasViewport.ts    # 视口缩放、定位、适配、缩放回调
│   │   ├── useVisibleScene.ts      # rbush 常驻增量索引（按矩形增删）、视口裁剪、连线筛选
│   │   ├── useCanvasInteractions.ts # 平移/框选/拖动/连线/空间拖动与四角调框/边缘自动平移/悬停会话（世界坐标增量）
│   │   ├── useVisibleThumbnails.ts # 可见图片 / 可执行对象的缩略图与图标延迟加载
│   │   ├── NodeShape.tsx           # 对象图标格、名称、标注条（独占底部区域）、扩展色描边、四向锚点
│   │   ├── GroupShape.tsx          # 空间实线框与命中区域（折叠时只画标题条高度）
│   │   ├── EdgeLayer.tsx           # 有向连线、标签、连线菜单
│   │   ├── Minimap.tsx             # 迷你地图与点击定位（折叠空间按标题条绘制）
│   │   ├── geometry.ts             # 坐标、名称、类型色、连线路径（纯函数）
│   │   ├── icons.tsx               # 系统图标与缩略图缓存（缩略图有 400 张上界）
│   │   ├── constants.ts            # 迷你地图、名称预算、标注高度、空间调色板、渲染倍率等常量
│   │   └── types.ts                # 右键目标、视口、舞台尺寸类型
│   ├── components/                 # 通用界面组件
│   │   ├── TitleBar.tsx            # 无边框标题栏：搜索（含类型筛选）、新建内容、大纲开关、设置下拉（系统设置/内容管理）、操作说明、窗口按钮
│   │   ├── SystemIcon.tsx          # 文件夹 / PDF / Word / Excel / DWG / EXE / 图片 / 视频 / TXT / 链接 / 富文本
│   │   ├── DetailsPanel.tsx        # 右键「属性」面板与标注编辑（只读属性，动作走右键菜单；标注 Ctrl+S 保存）
│   │   ├── ContextMenu.tsx         # 画布右键菜单渲染
│   │   ├── StatusBar.tsx           # 真实保存状态（保存中/已保存/失败）、对象数、缩放与画布按钮
│   │   ├── EmptyOverlay.tsx        # 空画布引导
│   │   ├── TextPromptDialog.tsx    # 连线标签 / 空间标题单行文本编辑
│   │   ├── TextContentDialog.tsx   # 文字卡内容弹窗（多行文本；Ctrl+S 就地保存、取消确认）
│   │   ├── RichTextDialog.tsx      # 富文本弹窗：按需加载的 wangEditor；Ctrl+S 就地保存、取消确认；图片/视频本地上传（Raw IPC 二进制直传）与 src 双向转换
│   │   ├── OutlinePanel.tsx        # 左侧大纲树：按空间分组，可逐个展开/收起并定位
│   │   ├── ContentManagerDialog.tsx # 内容管理：文字/富文本列表、移动到空间末尾、导出 txt / html+媒体
│   │   ├── ColorPickerDialog.tsx   # 空间与连线取色器
│   │   ├── NeighborPickerDialog.tsx # 一对多关联对象跳转选择
│   │   └── SettingsDialog.tsx      # 外观主题 / 工作空间 / 窗口 / 数据（含引用校验）/ 关于（版本读 package.json）
│   └── styles/global.css
├── desktop/                        # Tauri 2 桌面壳 / Rust 平台层（无移动端）
│   ├── Cargo.toml / Cargo.lock / build.rs
│   ├── tauri.conf.json             # decorations:false 无边框自定义标题栏、frontendDist ../client/dist、仅 nsis
│   ├── capabilities/default.json   # core / opener / dialog 权限；窗口拖动、最小化、关闭/销毁（关窗前落库后放行）与可见性查询
│   ├── installer-hooks.nsh         # NSIS 钩子：写入/删除「发送到」快捷方式
│   ├── icons/                      # 仅桌面图标
│   └── src/
│       ├── main.rs / lib.rs        # Tauri 启动（单实例 + 命令行/「发送到」转发）、全局热键、命令注册
│       ├── db.rs                   # dataWorkSpace、迁移（v4：groups.collapsed）、紧凑索引加载、增量保存（正文 COALESCE 保护）、分批可取消导入、按需取正文、导出、目录级校验/重连、缩略图、app_meta 与回归测试
│       ├── logging.rs              # 本地滚动日志（2MB 轮转、panic 钩子、前端上报）
│       ├── watcher.rs              # 目录级文件监听：防抖后增量校验并推送 refs://changed
│       ├── models.rs               # IPC DTO
│       └── platform.rs             # 路径规范化、文件类型、剪贴板文件读写、Shell 缩略图、原生右键菜单、窗口置底、OLE 拖出
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

- 画布渲染已切换到 Konva（`client/canvas/CanvasBoard.tsx`），场景模型与渲染层解耦，替换渲染器不影响业务命令。
- `App.tsx` 只做入口（主题状态 + Ant Design 容器）；场景命令在 `client/workspace/useSceneStore.ts`，交互在 `client/canvas/`，通用界面在 `client/components/`。
- 领域层 `client/domain` 尚未抽离：如需跨端复用或纯函数测试，再逐步从 `workspace/` 抽出，禁止把业务规则写回组件。

## 4. 功能域 → 文件速查

| 想知道什么 | 看哪里 |
| --- | --- |
| 能不能这么做 / 红线 | `docs/README.md` §3 硬约束清单 |
| v1 做什么 / 验收 | `docs/REQUIREMENTS.md` |
| 产品定位、架构总纲 | `docs/spec/00-overview.md` |
| 技术选型与历史决策 | `docs/spec/08-adr.md` |
| 窗口形态、高密度 UI、系统图标 | `desktop/tauri.conf.json`、`client/components/TitleBar.tsx`、`client/canvas/CanvasBoard.tsx`、`client/components/SystemIcon.tsx`、`docs/spec/03-ui-interaction.md` |
| 画布平移缩放、Konva 渲染、空间与锚点连线、不重叠与吸附（拖动期不校验、松手 rbush 判定落点）、自动整理、右键菜单、迷你地图 | `client/canvas/*`、`client/domain/layout.ts`、`docs/spec/02-client-architecture.md` §4 |
| 场景命令、选择、撤销/重做栈、方向键微调、标注、空间成员自动归属与进出空间整理、空间/连线配色、空间自动整理与手动调框 | `client/workspace/useSceneStore.ts` |
| 加载/保存/flush/关窗先落库/保存状态、缺失校验、拖入、快捷键、右键菜单动作、最小化暂停 | `client/workspace/useScenePersistence.ts`、`useShortcuts.ts`、`useContextMenu.ts`、`useWindowSuspended.ts`、`lib/tauri-api.ts` |
| 打开/定位/重连/导入与粘贴 | `client/workspace/useNodeActions.ts`、`useImportClipboard.ts` |
| 文字/富文本弹窗、加号新建菜单 | `client/components/TextContentDialog.tsx`、`RichTextDialog.tsx`、`TitleBar.tsx`、`client/workspace/Workspace.tsx` |
| 原文件复制与拖出（CF_HDROP / OLE 拖放） | `desktop/src/platform.rs`、`desktop/src/lib.rs`、`client/canvas/useCanvasInteractions.ts`、`client/workspace/Workspace.tsx` |
| 安装包语言 / 「发送到」快捷方式 | `desktop/tauri.conf.json`（`bundle.windows.nsis`）、`desktop/installer-hooks.nsh` |
| 版本号（四处一致 + 发布日志） | `scripts/bump-version.mjs`、`scripts/check-spec.mjs`（HC-17）、`release/log.md` |
| 本地日志（含前端上报与 panic） | `desktop/src/logging.rs`、`desktop/src/lib.rs`（`log_write`）、`client/lib/tauri-api.ts`（`call` 统一上报） |
| 文件变更监听 | `desktop/src/watcher.rs`、`db.rs`（`ref_dirs` / `ref_check_under_dirs`）、`client/workspace/useScenePersistence.ts`（订阅 `refs://changed`） |
| 导入进度与取消 | `desktop/src/db.rs`（`import_paths_with_progress`）、`desktop/src/lib.rs`（`import://progress` / `cancel_import`）、`client/workspace/useImportClipboard.ts` |
| 大纲树 / 空间折叠 / 内容管理与导出 | `client/components/OutlinePanel.tsx`、`client/canvas/CanvasBoard.tsx`、`client/components/ContentManagerDialog.tsx`、`desktop/src/db.rs`（`export_contents`） |
| 全局热键与外部导入 | `desktop/src/lib.rs`（global-shortcut / `take_pending_imports`）、`client/workspace/Workspace.tsx` |
| 主题切换与语义令牌 | `client/lib/theme.ts`、`client/styles/global.css`、`docs/spec/03-ui-interaction.md` §10 |
| 富文本节点与编辑器（`richtext`、`body` 存 HTML、纯文本投影；媒体本地资产化见 ADR-029） | `client/components/RichTextDialog.tsx`、`client/workspace/useSceneStore.ts`（`commitContent`）、`docs/spec/08-adr.md` ADR-025 |
| 搜索归一化、拼音首字母与排序 | `client/domain/search.ts`、`client/workspace/useSearch.ts` |
| Tauri 命令、SQLite、导入去重 | `desktop/src/lib.rs`、`db.rs`、`models.rs`、`platform.rs` |
| 拖入 / 粘贴 / 打开 / 定位 | `client/workspace/useImportClipboard.ts`、`useNodeActions.ts`、`client/lib/tauri-api.ts` |
| 搜索、标注、设置 | `client/workspace/useSearch.ts`、`useContextMenu.ts`、`TitleBar.tsx`、`DetailsPanel.tsx`、`SettingsDialog.tsx` |
| 场景模型与共享类型 | `client/types/scene.ts` |
| 表结构、dataWorkSpace、ID | `docs/spec/04-data-model.md` |
| 文件打开/定位、缩略图、缺失 | `docs/spec/05-file-reference-contract.md` |
| 拖入/粘贴/去重/失败语义 | `docs/spec/06-import-pipeline.md` |
| 安装包、WebView2、数据路径 | `docs/spec/07-packaging.md` |
| 命名、注释、错误处理、工具链 | `docs/coding-conventions.md` |

## 5. 待补地图项

- 视频封面、图片预览已砍：一律系统打开，不再保留相关地图项。
- `client/shared`（IPC 契约集中于 `tauri-api.ts`，暂未需要独立目录）。
- 基准实测与 NSIS 安装验收已完成（基准数字为性能优化前测得，必要时重测）。
- 代码签名（未做，不影响功能验证）。
