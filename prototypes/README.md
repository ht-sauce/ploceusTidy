# prototypes · 络雀原型目录

> 当前原型由前端工程直接承载；本目录保留规则、入口说明与历史归档。

## 用途

- 表达核心界面形态：无边框窗口、高密度系统图标行、顶部搜索与定位、标注、设置、紧凑模式。
- 作为实现前的评审依据；生产代码位于 `client/`，不放在本目录。
- 原型用模拟数据，不连接文件系统，不读取真实文件。

## 目录约定

```text
prototypes/
├── README.md          # 本文件：用途、规则、当前入口
└── archive/           # 历史版本，仅参考
    └── 20261024-canvas-workspace-v0/
        └── index.html # 已否决的手写 HTML 原型
```

- 当前原型不再维护独立 HTML；直接运行前端工程：`pnpm install` → `pnpm dev`。
- 历史版本只增不改；归档文件标注「仅参考，不作为依据」。

## 规则

1. **单一演进对象**：只维护一份最新原型，即 `client/` 中的 React 工程。
2. **模拟数据**：不连接真实文件系统；使用 `client/data/mock-scene.ts` 的 1000 条引用。
3. **页面不出现实现细节**：不展示代码、配置键、内部路径；入口文案用中文。
4. **无过度设计**：系统图标、176×28 紧凑行、文件名单行省略、路径悬停显示；不做大缩略图卡片、渐变或装饰性面板。
5. **变更同批登记**：新增 / 改名 / 归档原型时，同批更新 [project-overview](../docs/project-overview.md) 与 [03-ui-interaction](../docs/spec/03-ui-interaction.md) §9。

## 当前状态

| 项 | 状态 |
| --- | --- |
| 当前原型 | 前端工程 `client/`；运行 `pnpm dev`，默认 `http://127.0.0.1:5173/` |
| 评审重点 | 密度（1000 条引用、同屏 120+ 行）、16px 系统图标、无边框标题栏、项目 logo、搜索定位、多选/框选、批量标注、有向连线、删除撤销、文字编辑、图片预览、设置、紧凑模式 |
| 关联文档 | [REQUIREMENTS](../docs/REQUIREMENTS.md)、[00-overview](../docs/spec/00-overview.md)、[03-ui-interaction](../docs/spec/03-ui-interaction.md) |
| 前置条件 | 需求与架构已确认；Tauri 后端可编译，本机启动受 Windows 应用控制策略阻止（os error 4551） |
| 旧 HTML 原型 | `archive/20261024-canvas-workspace-v0/`，仅参考 |
