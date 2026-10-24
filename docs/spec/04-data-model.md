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
- `scene_save` 按 ID 增量 upsert，只清理本次快照之外的对象；`refs` 的 `size` / `mtime` / `is_exists` / `thumb_key` 由导入与校验流程维护，保存流程不覆盖。
- 不在数据库中存文件内容；只存路径、URL、文本、标注与画布坐标。

## 3. 表

### `refs`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | UUID |
| `kind` | TEXT | `file` / `folder` / `link`；截图与图片按 `file` 存工作空间路径 |
| `dedupe_key` | TEXT NULL | 仅文件/文件夹使用：规范化真实路径；文字、URL、截图不填 |
| `path` | TEXT NULL | 文件/文件夹绝对路径；截图副本为工作空间内的绝对路径 |
| `url` | TEXT NULL | 链接 |
| `name` | TEXT | 展示名称 |
| `ext` | TEXT NULL | 扩展名 |
| `size` | INTEGER NULL | 字节数 |
| `mtime` | INTEGER NULL | 修改时间（epoch ms） |
| `is_exists` | INTEGER NOT NULL DEFAULT 1 | 文件是否存在；`link` 恒为 1 |
| `thumb_key` | TEXT NULL | 缩略图缓存键 |
| `search_text` | TEXT NOT NULL DEFAULT '' | 归一化搜索文本 |
| `created_at` | INTEGER | epoch ms |
| `updated_at` | INTEGER | epoch ms |

- 唯一索引为 `UNIQUE(kind, dedupe_key) WHERE dedupe_key IS NOT NULL`；只有文件/文件夹写入 `dedupe_key`，`link` 不参与去重。
- 同一 `ref` 只允许一张卡片（见 `nodes.ref_id` 唯一约束）。

### `groups`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | UUID |
| `title` | TEXT | 分组框标题 |
| `x`,`y`,`w`,`h` | REAL | 世界坐标与尺寸（按内容收高） |
| `created_at` / `updated_at` | INTEGER | epoch ms |

### `nodes`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | UUID |
| `type` | TEXT | `file` / `folder` / `image` / `video` / `text` / `link` |
| `icon` | TEXT | 展示用系统图标种类，不参与业务判断 |
| `name` | TEXT | 展示名称 |
| `subtitle` | TEXT NOT NULL DEFAULT '' | 副标题：所在目录或来源 |
| `body` | TEXT NULL | 文字卡内容 |
| `ref_id` | TEXT NULL UNIQUE | 引用；文字卡为空 |
| `group_id` | TEXT NOT NULL DEFAULT '' | 所属分组框 `groups.id`；空字符串表示未分组 |
| `z` | INTEGER NOT NULL DEFAULT 0 | 叠放层级 |
| `parent_node_id` | TEXT NULL | 规划字段：相对父节点挂载，当前未实现 |
| `data_json` | TEXT NULL | 规划字段：扩展样式，当前未写入 |
| `x`,`y`,`w`,`h` | REAL | 画布坐标与尺寸（默认 72×64 图标格） |
| `created_at` | INTEGER | epoch ms |
| `updated_at` | INTEGER | epoch ms |

- `UNIQUE(ref_id)` 允许 NULL（SQLite 允许多个 NULL）。
- 删除分组框时 `group_id` 置空，不删内部节点；`scene_save` 末尾会把指向不存在分组的 `group_id` 归一为空。

### `edges`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | UUID |
| `from_node` / `to_node` | TEXT | 起止节点 ID |
| `from_handle` / `to_handle` | TEXT NULL | 规划字段：锚点，当前未实现 |
| `label` | TEXT NULL | 连线标签 |
| `style_json` | TEXT NULL | 规划字段：线型与颜色，当前未写入 |
| `created_at` | INTEGER NOT NULL DEFAULT 0 | epoch ms |

### `annotations` 与 `annotation_targets`

- `annotations(id, color, text, created_at, updated_at)`。
- `annotation_targets(annotation_id, node_id)`，复合主键，无自增。
- 删除节点时删除对应 `annotation_targets`；无目标的标注一并删除。

### `app_meta`

- `key` / `value`，存视口类配置与界面主题（`ui_theme`）、桌面常驻（`desktop_pin`）、最小化暂停（`pause_when_minimized`）。
- `ui_theme` 只存主题 ID，不存整套色值；缺省或无法识别时回退 `mist-purple`。
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
- v1 用 `LIKE '%q%'` 查询 `refs.search_text`、`nodes.body`、`annotations.text`；`edges.label` 待连线标签实现后再加入。
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
