# 络雀（ploceusTidy）

<p align="center">
  <img src="assets/ploceusTidy.jpg" alt="络雀：正在织巢的织雀" width="480">
</p>

把电脑里的文件、截图、文字、URL 放到一张无限画布上，分组、连线、标注，并用顶部搜索快速定位。只保存引用，原文件不动。

名字取自织雀筑巢——把散落的材料编织成有序的巢，正如把散落的文件、文字与链接织成一张可检索的关系网。

> 当前处于前端原型阶段：React 工程与高密度画布原型已落地，Tauri 后端尚未开始。

## 当前状态

| 项 | 状态 |
| --- | --- |
| 需求基线 | 已建立：[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) |
| 规范文档 | 已建立（入口：[docs/README.md](docs/README.md)） |
| 前端工程 | React 19.3.1 + TypeScript 6.0.3 + Vite 8.3.5 + Ant Design 6.6.7，目录 `client/` |
| 界面原型 | 直接用前端工程承载，运行 `pnpm dev` 查看 |
| 桌面壳 | Tauri 2，目录 `desktop/`；已实现导入、SQLite、打开/定位、剪贴板文件、图片预览命令 |
| 本机运行 | `pnpm tauri build --no-bundle` 已产出 release exe 并可启动；`pnpm tauri:dev` 的 debug exe 被 Windows 应用控制策略阻止（os error 4551），可改用 `pnpm tauri:dev:release` |
| 旧 HTML 原型 | 已归档：[prototypes/archive](prototypes/archive) |

## 已实现

- 拖入文件/文件夹、复制文件后粘贴、粘贴文字/URL/截图。
- 文件按真实路径去重，重复导入自动定位已有行。
- SQLite 持久化到 `dataWorkSpace`，自动保存。
- 顶部搜索，结果定位并高亮；`Ctrl+K` 聚焦。
- 多选（Shift/Ctrl 点击、Shift 框选）、批量标注、`L` 建立有向连线、`Del` 删除、`Ctrl+Z` 撤销。
- 文字卡双击编辑；图片用 Ant Design 图片预览；文件/文件夹/URL 打开原对象或在资源管理器中定位。
- 无边框窗口、项目 logo、16px 系统图标、176×28 紧凑行、路径 Tooltip、紧凑模式。

## 待补

- Windows Shell 原生缩略图与视频封面。
- 分组框创建/移动、锚点拖拽连线、边标签、边删除。
- 缺失文件检测与重新关联、工作空间迁移。
- 十万级 Konva 渲染层与虚拟化优化。
- 安装包签名与正式发布。

## 开发命令

| 用途 | 命令 |
| --- | --- |
| 安装依赖 | `pnpm install` |
| 开发启动（浏览器原型） | `pnpm dev` |
| 开发启动（桌面客户端） | `pnpm tauri:dev`；若本机策略拦截 debug exe，用 `pnpm tauri:dev:release` |
| 构建前端 | `pnpm build` |
| 构建桌面安装包 | `pnpm tauri:build` |
| 预览构建产物 | `pnpm preview` |
| 静态检查 | `pnpm lint` |
| 格式化 | `pnpm format` |

## 核心原则

- **只读引用**：不移动、不改名、不删除用户文件。
- **零心智负担**：导入不弹窗；重复文件自动定位；搜索即定位；自动保存。
- **高密度**：系统图标 + 紧凑行；数千个文件同屏可浏览，远景降级为色点。
- **纯本地**：不接云端，不上传文件内容或元数据。
- **简单**：无边框窗口、顶部搜索常驻、不过度设计。

## 开发前必读

1. [AGENTS.md](AGENTS.md) —— AI 协作入口与硬边界
2. [docs/README.md](docs/README.md) —— 硬约束清单与工作流
3. [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) —— v1 需求与验收
4. [docs/project-overview.md](docs/project-overview.md) —— 文件级地图

## 范围

v1：拖入/粘贴文件、文字、截图、URL → 画布分组、连线、标注 → 顶部搜索定位 → 打开原文件/浏览器/图片查看器。详见 [00-overview.md](docs/spec/00-overview.md)。
