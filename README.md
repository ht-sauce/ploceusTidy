# 络雀（ploceusTidy）

<p align="center">
  <img src="assets/ploceusTidy.jpg" alt="络雀：正在织巢的织雀" width="480">
</p>

把电脑里的文件、截图、文字、URL 放到一张无限画布上，分组、连线、标注，并用顶部搜索快速定位。只保存引用，原文件不动。

名字取自织雀筑巢——把散落的材料编织成有序的巢，正如把散落的文件、文字与链接织成一张可检索的关系网。

> 当前为可运行的 Windows 桌面客户端：React 画布 + Tauri 2 + SQLite 已打通，导入、组织、连线、标注、搜索、打开/定位链路可用。

## 当前状态

| 项 | 状态 |
| --- | --- |
| 形态 | Windows 10/11 x64 桌面客户端；纯本地，无云端、无遥测，不含移动端 |
| 前端 | React 19.3.1 + TypeScript 6.0.3 + Vite 8.3.5 + Ant Design 6.6.7，目录 `client/` |
| 画布 | Konva 10 + react-konva + rbush：视口裁剪、高清倍率（≥2）、任意缩放都绘制完整对象 |
| 桌面壳 | Tauri 2 + Rust，目录 `desktop/`；SQLite、剪贴板文件、Shell 缩略图与图标、原生右键菜单、打开/定位、窗口控制 |
| 数据 | `dataWorkSpace/`：`ploceus.db` + `assets/` + `thumbnails/`；`user_version` 迁移 |
| 本机运行 | `pnpm tauri:dev` 以 release 模式启动；安装包命令 `pnpm tauri:build`（安装验收待补） |

## 核心能力

- 导入：拖入文件/文件夹、粘贴资源管理器文件、粘贴文字/URL/截图；文件按真实路径去重，重复导入自动定位。
- 组织：无限画布平移缩放、框选多选、拖动、空间（分组框）创建与整体移动；对象拖入空间自动成为成员，拖出自动脱离。
- 关系：有向虚线箭头，支持四向锚点拖拽、多选 + `L` 批量连线、标签、颜色与删除；选中连线或空间时按自身颜色外发光；节点与空间都可作端点。
- 标注：多选批量标注，文字牌骑在对象下边框并跟随主题主色；空间标题即空间标注，可自动编号、重命名与取色。
- 定位：顶部模糊搜索、定位高亮、迷你地图点击/拖拽定位；有连线的对象可右键跳转到关联对象（一对多时弹出选择）。
- 外观：四套浅色主题（灰雾紫 / 石板蓝灰 / 青禾灰绿 / 石墨灰），语义色令牌统一 React、Ant Design 与 Konva。
- 文件：双击打开原文件/文件夹/URL，图片内置预览；右键在资源管理器中定位，并可调用 Windows 原生 Shell 右键菜单（含 WinRAR、Git 等第三方扩展）；快捷方式显示目标程序图标；缺失文件校验与重新关联。
- 可靠性：自动保存、删除可撤销、失败带路径与原因上报；工作空间可打开、迁移、重建。

## 项目结构

```text
ploceusTidy/
├── AGENTS.md              # AI 协作入口与硬边界
├── README.md              # 本文件
├── package.json           # 前端依赖与命令
├── client/                # React 前端
│   ├── App.tsx            # 仅入口：主题状态 + Ant Design 容器
│   ├── workspace/         # 编排层：场景命令、持久化、导入、动作、快捷键、右键菜单
│   ├── canvas/            # 画布层：CanvasBoard + 视口/裁剪/交互 hook + 图元组件
│   ├── components/        # 通用界面：标题栏、属性面板、右键菜单、对话框
│   ├── lib/               # Tauri invoke、主题令牌、搜索
│   ├── types/             # 场景与 IPC 共享类型
│   └── styles/            # 语义色变量与全局样式
├── desktop/               # Tauri 2 桌面壳与 Rust 平台层
│   └── src/               # main.rs / lib.rs / db.rs / models.rs / platform.rs
├── docs/                  # 规范入口、需求基线、文件地图、spec/00–08
├── scripts/               # check-spec 规范扫描
├── assets/                # 品牌图
└── dataWorkSpace/         # 运行时生成，不入库
```

## 开发命令

| 用途 | 命令 |
| --- | --- |
| 安装依赖 | `pnpm install` |
| 开发启动（浏览器调试） | `pnpm dev` |
| 开发启动（桌面客户端，release） | `pnpm tauri:dev` |
| 构建前端 | `pnpm build` |
| 构建桌面安装包 | `pnpm tauri:build` |
| Rust 测试 | `cargo test --manifest-path desktop/Cargo.toml --lib` |
| 静态检查 | `pnpm lint` / `pnpm lint:fix` |
| 格式化 | `pnpm format` / `pnpm format:check` |
| 规范扫描 | `pnpm check-spec` |

- debug exe 会被本机应用控制策略阻止（os error 4551），开发统一使用 release 模式。
- 提交前手动执行 `pnpm lint`、`pnpm format:check`、`pnpm check-spec`。

## 核心原则

- **只读引用**：不移动、不改名、不删除用户文件；只保存路径与展示元数据。
- **零心智负担**：导入不弹窗；重复文件自动定位；搜索即定位；自动保存；删除可撤销。
- **高密度**：Windows 桌面式系统图标网格，卡片高度自适应，数千文件可浏览；不做大缩略图卡片。
- **纯本地**：不接云端，不上传文件内容或元数据；URL 仅交给系统浏览器。
- **简单**：无边框窗口、顶部搜索常驻、画布默认不动，不过度设计。

## 开发前必读

1. [AGENTS.md](AGENTS.md) —— AI 协作入口与硬边界
2. [docs/README.md](docs/README.md) —— 硬约束清单与工作流
3. [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) —— v1 需求与验收
4. [docs/project-overview.md](docs/project-overview.md) —— 文件级地图

## 范围与边界

v1：拖入/粘贴文件、文字、截图、URL → 画布分组、连线、标注 → 顶部搜索定位 → 打开原文件/浏览器/图片查看器。详见 [00-overview.md](docs/spec/00-overview.md)。

不做：文件移动/改名/删除、递归扫描、全盘索引、文件内容索引/OCR、云端协作、内嵌视频播放、多画布。

## 已知待补

- 视频封面提取、图片预览自定义协议（避免大图 base64）。
- 1 万 / 10 万画布基准实测（含高清倍率的显存与帧率）。
- NSIS 安装包验收与代码签名；自动更新不在 v1。
