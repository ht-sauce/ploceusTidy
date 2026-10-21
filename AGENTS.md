# AGENTS.md · 络雀（ploceusTidy）

> 个人文件整理客户端。规则全文只存在于 `docs/`，本文件只做导航与硬边界提示，不复制规则。

## 1. 项目速览

| 项 | 当前值 |
| --- | --- |
| 产品名 | 络雀（仓库名 `ploceusTidy`） |
| 定位 | 方便快捷的个人文件整理客户端 |
| 形态 | A · 代码工程，桌面客户端 |
| 技术栈 | **待定**：框架、语言、存储、工程结构均未决 |
| 持久化 | 待定（预期承载索引、分类规则、整理历史、撤销记录） |
| 外部数据源 | 待定；当前按「纯本地」约束，接外部 API 须显式开启 |
| 运行环境 | 单环境，本地运行，不建端口表 |
| 当前阶段 | 仅有规范文档，无源码 |

## 2. 命令

> 技术选型确定前没有可执行命令。选型落地时**同批**补齐下表，并同步 `README.md` 与 `docs/project-overview.md`。

| 用途 | 命令 |
| --- | --- |
| 安装依赖 | 待定 |
| 开发启动 | 待定 |
| 构建 / 打包 | 待定 |
| 测试 | 待定 |
| 静态检查 / 格式化 | 待定 |
| 规范扫描（check-spec） | 未建；可静态化的硬约束在选型后脚本化 |

## 3. 目录速览

```
ploceusTidy/
├── AGENTS.md                  # AI 入口（本文件）
├── README.md                  # 人类入口
├── assets/                    # 品牌与文档图片
├── prototypes/                # 界面原型（规则见 prototypes/README.md）
├── docs/
│   ├── README.md              # 规范入口：硬约束 + 工作流
│   ├── project-overview.md    # 文件级地图
│   ├── coding-conventions.md  # 编码约定
│   └── spec/
│       ├── INDEX.md           # 文集地图 + 维护契约 + 书写约定
│       ├── 00-overview.md     # 定位 / 架构原则 / 质量属性 / 范围
│       └── 08-adr.md          # ADR 机制 + 待决清单
└── src/ 等源码目录            # 未创建，随技术选型落地
```

## 4. 接需求必读（强制第一步）

1. `docs/README.md` —— 硬约束清单与工作流。
2. `docs/coding-conventions.md` —— 编码约定。
3. 按任务范围加读 `docs/spec/00-overview.md`、`docs/spec/08-adr.md`。
4. 用 `docs/project-overview.md` 定位文件，只精读目标文件；禁止全量扫描。

单行 typo / 单行 bug 可简化流程，但仍须遵守硬约束。

## 5. 硬边界（违反会直接出问题，全文见 `docs/README.md` §3）

- NEVER 未读 `docs/README.md` 就改动文件。
- NEVER 在技术选型未定时引入框架、依赖、脚手架或生成器。
- NEVER 让删除 / 覆盖成为不可恢复的直达操作。
- NEVER 无操作记录地批量移动、改名、归档。
- NEVER 让文件操作越出用户选定的根目录。
- NEVER 将文件内容或元数据发往本机之外（除非用户显式开启）。
- NEVER 静默跳过失败文件；失败必须带路径与原因上报。
- NEVER 用自增 ID 作为表关联键（选型后同样适用）。
- NEVER 边读边改、边对话边改；方案确认后一次性批量改动。
- NEVER 未经明确要求执行 `git commit` / `git push`。

## 6. 文档索引

| 文档 | 用途 |
| --- | --- |
| [docs/README.md](docs/README.md) | ★ 规范入口：必读流程、硬约束、工作流 |
| [docs/project-overview.md](docs/project-overview.md) | 技术栈现状 + 文件级职责地图 |
| [docs/coding-conventions.md](docs/coding-conventions.md) | 技术栈无关的编码约定与待补项 |
| [docs/spec/INDEX.md](docs/spec/INDEX.md) | 文集地图、阅读顺序、维护契约、书写约定 |
| [docs/spec/00-overview.md](docs/spec/00-overview.md) | 定位、架构分层、质量属性、v1 范围 |
| [docs/spec/08-adr.md](docs/spec/08-adr.md) | 架构决策记录机制与待决项 |

## 7. 待决事项（不得擅自拍板）

| 待决项 | 候选 | 触发时机 |
| --- | --- | --- |
| 技术选型 | Electron + Vue / Tauri / 本地 Web / 其他 | 开始写第一行业务代码前 |
| 工程结构 | 单体 / Monorepo | 确定框架后 |
| 数据存储 | 本地数据库 / 文件清单 / 无持久化 | 确定整理历史与撤销方案时 |
| 外部数据源 | 纯本地 / 接模型 API / 本地 + 可选 AI | 确定分类策略时 |

决策一经确认，按 `docs/spec/08-adr.md` 补 ADR，并同批补齐命令表、工程结构与领域规范。
