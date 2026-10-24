# 04-data-model.md · 数据模型

## 1. dataWorkSpace

```text
dataWorkSpace/
├── ploceus.db          # SQLite 主库
├── assets/             # 粘贴的截图/图片副本
│   └── <uuid>.<ext>
├── thumbnails/         # 系统缩略图/图标缓存
│   └── <refId>.png
└── logs/               # 运行日志
```

- 默认位置：安装目录下的 `dataWorkSpace/`（仅当目录可写）。
- 回退位置：安装目录不可写时，使用 `%LOCALAPPDATA%\ploceusTidy\dataWorkSpace`。
- 用户可在设置中更改；迁移流程为复制 → 校验 → 切换，失败保留旧目录。
- 数据库、资源、缩略图必须同属一个工作空间，不跨目录混用。
- `dataWorkSpace` 是唯一写入区域；用户文件只读。

## 2. SQLite 约定

- `PRAGMA journal_mode=WAL`；`foreign_keys=ON`；`busy_timeout=5000`。
- 迁移用 `PRAGMA user_version`，迁移脚本按版本顺序执行。
- 每条命令一个事务；失败整体回滚。
- 不在数据库中存文件内容；只存路径、URL、文本、标注与画布坐标。

## 3. 表

### `refs`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | UUID |
| `kind` | TEXT | `file` / `folder` / `link` / `asset` |
| `dedupe_key` | TEXT NULL | 仅文件/文件夹使用：规范化真实路径；文字、URL、截图不填 |
| `path` | TEXT NULL | 文件/文件夹绝对路径；asset 为工作空间相对路径 |
| `url` | TEXT NULL | 链接 |
| `name` | TEXT | 展示名称 |
| `ext` | TEXT NULL | 扩展名 |
| `size` | INTEGER NULL | 字节数 |
| `mtime` | INTEGER NULL | 修改时间（epoch ms） |
| `exists` | INTEGER | 文件是否存在；link 恒为 1 |
| `thumb_key` | TEXT NULL | 缩略图缓存键 |
| `search_text` | TEXT | 归一化搜索文本 |
| `created_at` | INTEGER | epoch ms |
| `updated_at` | INTEGER | epoch ms |

- 文件/文件夹使用部分唯一索引 `UNIQUE(kind, dedupe_key) WHERE kind IN ('file','folder')`；`link`/`asset` 不参与去重。
- 同一 `ref` 只允许一张卡片（见 `nodes.ref_id` 唯一约束）。

### `nodes`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | UUID |
| `type` | TEXT | `file` / `folder` / `image` / `video` / `link` / `text` / `frame` |
| `ref_id` | TEXT NULL UNIQUE | 引用；文字/分组框为空 |
| `text_content` | TEXT NULL | 文字卡内容；分组框标题 |
| `x`,`y`,`w`,`h` | REAL | 画布坐标与尺寸 |
| `z` | INTEGER | 层级 |
| `parent_node_id` | TEXT NULL | 分组框父节点 |
| `data_json` | TEXT | 卡片样式、标注颜色等扩展 |
| `created_at` | INTEGER | epoch ms |
| `updated_at` | INTEGER | epoch ms |

- `UNIQUE(ref_id)` 允许 NULL（SQLite 允许多个 NULL）。
- 分组框是 `type=frame` 的节点；子节点坐标相对父节点。

### `edges`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | UUID |
| `source_node_id` | TEXT | 起点 |
| `target_node_id` | TEXT | 终点 |
| `source_handle` | TEXT | 起点锚点 |
| `target_handle` | TEXT | 终点锚点 |
| `label` | TEXT NULL | 可选标签 |
| `style_json` | TEXT | 线型/颜色 |
| `created_at` | INTEGER | epoch ms |

### `annotations` 与 `annotation_targets`

- `annotations(id, content, color, created_at, updated_at)`。
- `annotation_targets(annotation_id, node_id)`，复合主键，无自增。
- 删除节点时删除对应 `annotation_targets`；无目标的标注一并删除。

### `app_meta`

- `key` / `value`：视口（`viewport`）、schema 版本、最近打开时间等。
- 工作空间路径不入库，放在应用配置层（HC-9）。

## 4. ID 规则

- 所有主键与关联键使用 `crypto.randomUUID()` / Rust `Uuid` 生成的 TEXT。
- 禁止 `INTEGER PRIMARY KEY AUTOINCREMENT`；禁止用自增 ID 作为关联键（HC-15）。
- 关系表使用复合主键，不引入无业务意义的自增主键。

## 5. 去重与删除

- 文件/文件夹：按 `(kind, dedupe_key)` 去重；重复导入返回已有 `node`，不插入。
- 文字、截图、URL：不去重。
- 删除卡片：删除 `nodes` 行、对应 `edges`、`annotation_targets`；删除无节点引用的 `refs`；同一事务。
- 原文件永远不动；撤销通过命令栈恢复节点与引用。

## 6. 搜索

- `search_text` 在写入时归一化：NFKC、小写、`\`→`/`、去多余空白。
- v1 用 `LIKE '%q%'` 查询 `refs.search_text`、`nodes.text_content`、`annotations.content`、`edges.label`。
- 5 万引用后评估 FTS5 trigram 或内存 n-gram 索引；拼音首字母作为可选增强。
- 排序：名称精确 > 前缀 > 子串 > 路径 > 标注/文字。

## 7. 恢复

- 不做自动备份、多副本、云端容灾。
- WAL + 事务保证单次命令一致性；异常重启后由 SQLite 恢复。
- 数据库损坏时提供「重建工作空间」：新建空库，保留 `assets`/`thumbnails` 可选清理；用户重新导入文件。
- 崩溃由代码缺陷导致时按缺陷修复，不用数据层兜底。

## 8. 约束

- 数据不出本机；不写入用户文件；不跟随符号链接越出显式导入边界。
- 所有路径与配置从统一配置层读取，禁止散落字面量（HC-9）。
