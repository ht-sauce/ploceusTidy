//! 工作空间与 SQLite 访问层。
//!
//! - `dataWorkSpace` 是唯一写入区域：`ploceus.db`、`assets/`、`thumbnails/`；
//! - 所有主键与关联键使用 UUID（HC-15），文件/文件夹按规范化真实路径去重；
//! - 每条命令一个事务，失败整体回滚；用户文件永远只读（HC-12）；
//! - 读写分离：写连接由 Mutex 串行化，读走独立连接（WAL 下读不被写事务阻塞），
//!   场景加载一次性拿完，缩略图元信息走进程内缓存，避免视图操作与保存抢锁。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension, Row};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::models::{
    ImportError, ImportRequest, ImportResult, RefStatus, SceneAnnotation, SceneData, SceneDelta,
    SceneEdge, SceneNode, WorkspaceInfo,
};
use crate::platform::{
    clean_path, file_icon_and_kind, normalize_path_key, now_ms, subtitle_for_path,
};

/// 缩略图元信息缓存条目：进程内缓存，避免每张可见缩略图都锁一次数据库。
#[derive(Clone)]
pub struct ThumbMeta {
    pub path: String,
    pub exists: bool,
    pub thumb_key: Option<String>,
}

/// 全局状态：写连接串行化，读连接独立；工作空间路径可在迁移后替换。
pub struct AppState {
    pub db: Mutex<Connection>,
    /// 只读连接：WAL 模式下读走快照，不等待写事务提交。
    pub reader: Mutex<Connection>,
    pub workspace: Mutex<PathBuf>,
    pub assets: Mutex<PathBuf>,
    /// `node_id → 缩略图元信息`；`None` 表示该节点无需缩略图（文字/链接）。
    /// relink / 引用校验后按 id 失效对应条目。
    pub thumb_meta: Mutex<HashMap<String, Option<ThumbMeta>>>,
}

impl AppState {
    /// 当前工作空间目录；迁移后会更新，调用方不要在启动时缓存。
    pub fn workspace_path(&self) -> Result<PathBuf, String> {
        self.workspace
            .lock()
            .map(|value| value.clone())
            .map_err(|error| error.to_string())
    }

    fn assets_path(&self) -> Result<PathBuf, String> {
        self.assets
            .lock()
            .map(|value| value.clone())
            .map_err(|error| error.to_string())
    }
}

/// 当前 schema 版本；迁移按 `PRAGMA user_version` 递增执行。
const SCHEMA_VERSION: i64 = 3;

/// 初始化表结构；只做 `CREATE ... IF NOT EXISTS`，不破坏已有数据。
/// 关系表使用复合主键，`refs` 只在文件/文件夹上建立部分唯一索引用于去重。
fn schema() -> &'static str {
    r#"
    CREATE TABLE IF NOT EXISTS refs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        dedupe_key TEXT,
        path TEXT,
        url TEXT,
        name TEXT NOT NULL,
        ext TEXT,
        size INTEGER,
        mtime INTEGER,
        is_exists INTEGER NOT NULL DEFAULT 1,
        thumb_key TEXT,
        search_text TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS refs_dedupe
        ON refs(kind, dedupe_key)
        WHERE dedupe_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        color TEXT,
        x REAL NOT NULL,
        y REAL NOT NULL,
        w REAL NOT NULL,
        h REAL NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        icon TEXT NOT NULL,
        name TEXT NOT NULL,
        subtitle TEXT NOT NULL DEFAULT '',
        body TEXT,
        ref_id TEXT UNIQUE,
        group_id TEXT NOT NULL DEFAULT '',
        z INTEGER NOT NULL DEFAULT 0,
        parent_node_id TEXT,
        data_json TEXT,
        x REAL NOT NULL,
        y REAL NOT NULL,
        w REAL NOT NULL,
        h REAL NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(ref_id) REFERENCES refs(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS nodes_group ON nodes(group_id);
    CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        from_node TEXT NOT NULL,
        to_node TEXT NOT NULL,
        from_handle TEXT,
        to_handle TEXT,
        label TEXT,
        style_json TEXT,
        created_at INTEGER NOT NULL DEFAULT 0
    );
    -- 保存时的悬空边清理与邻居查询都按端点过滤；10 万节点下没有索引就是全表扫。
    CREATE INDEX IF NOT EXISTS edges_from ON edges(from_node);
    CREATE INDEX IF NOT EXISTS edges_to ON edges(to_node);
    CREATE TABLE IF NOT EXISTS annotations (
        id TEXT PRIMARY KEY,
        color TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS annotation_targets (
        annotation_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        PRIMARY KEY (annotation_id, node_id),
        FOREIGN KEY(annotation_id) REFERENCES annotations(id) ON DELETE CASCADE
    );
    -- 保存时按节点清理标注目标需要该方向的索引。
    CREATE INDEX IF NOT EXISTS annotation_targets_node ON annotation_targets(node_id);
    CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    "#
}

/// 旧库补列：`PRAGMA table_info` 判断列是否已存在，避免重复 ALTER 报错。
fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| format!("读取表结构失败：{error}"))?;
    let mut rows = statement
        .query([])
        .map_err(|error| format!("读取表结构失败：{error}"))?;
    while let Some(row) = rows.next().map_err(|error| error.to_string())? {
        let name: String = row.get(1).map_err(|error| error.to_string())?;
        if name == column {
            return Ok(());
        }
    }
    connection
        .execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition}"
        ))
        .map_err(|error| format!("升级表 {table} 失败：{error}"))
}

/// 升级到当前版本：先建新表，再补列，最后归一历史分组标识。
/// 整个迁移在一个事务内完成，失败回滚，不会留下半成品 schema。
fn migrate(connection: &mut Connection) -> Result<(), String> {
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("读取 schema 版本失败：{error}"))?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }

    let transaction = connection
        .transaction()
        .map_err(|error| format!("开启迁移事务失败：{error}"))?;
    transaction
        .execute_batch(schema())
        .map_err(|error| format!("建表失败：{error}"))?;

    for (table, column, definition) in [
        ("nodes", "z", "INTEGER NOT NULL DEFAULT 0"),
        ("nodes", "parent_node_id", "TEXT"),
        ("nodes", "data_json", "TEXT"),
        ("groups", "color", "TEXT"),
        ("edges", "from_handle", "TEXT"),
        ("edges", "to_handle", "TEXT"),
        ("edges", "label", "TEXT"),
        ("edges", "style_json", "TEXT"),
        ("edges", "created_at", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        ensure_column(&transaction, table, column, definition)?;
    }

    transaction
        .execute(
            "UPDATE nodes SET group_id = '' WHERE group_id = 'other'",
            [],
        )
        .map_err(|error| format!("归一历史分组失败：{error}"))?;
    transaction
        .execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))
        .map_err(|error| format!("写入 schema 版本失败：{error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("提交迁移失败：{error}"))?;
    Ok(())
}

/// 选择工作空间目录：优先安装目录（可写时），否则回退 Tauri `app_data_dir`。
/// 两个候选都按“能否创建目录”判断可写性，避免把数据库写到只读目录。
fn resolve_workspace(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();

    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            candidates.push(parent.join("dataWorkSpace"));
        }
    }

    if let Ok(app_data) = app.path().app_data_dir() {
        candidates.push(app_data.join("dataWorkSpace"));
    }

    for candidate in candidates {
        if fs::create_dir_all(&candidate).is_ok() {
            return Ok(candidate);
        }
    }

    Err("无法创建 dataWorkSpace".to_string())
}

/// 连接级 PRAGMA：WAL + 外键 + busy_timeout 是并发与一致性的前提；
/// `synchronous=NORMAL` 在 WAL 下安全且省掉每次提交的 fsync；
/// `temp_store=MEMORY` 让保存清理用的临时表留在内存；缓存与 mmap 加大读写吞吐。
fn apply_pragmas(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             PRAGMA busy_timeout=5000;
             PRAGMA synchronous=NORMAL;
             PRAGMA temp_store=MEMORY;
             PRAGMA cache_size=-8000;
             PRAGMA mmap_size=268435456;",
        )
        .map_err(|error| format!("初始化 SQLite 失败：{error}"))
}

/// 打开数据库并完成建表；写连接与读连接指向同一 WAL 库，读写互不阻塞。
pub fn initialize(app: &AppHandle) -> Result<AppState, String> {
    let workspace = resolve_workspace(app)?;
    let assets = workspace.join("assets");
    fs::create_dir_all(&assets).map_err(|error| format!("创建 assets 失败：{error}"))?;
    fs::create_dir_all(workspace.join("thumbnails"))
        .map_err(|error| format!("创建 thumbnails 失败：{error}"))?;

    let db_path = workspace.join("ploceus.db");
    let mut connection =
        Connection::open(&db_path).map_err(|error| format!("打开 SQLite 失败：{error}"))?;
    apply_pragmas(&connection)?;
    migrate(&mut connection)?;
    let reader =
        Connection::open(&db_path).map_err(|error| format!("打开只读连接失败：{error}"))?;
    apply_pragmas(&reader)?;

    Ok(AppState {
        db: Mutex::new(connection),
        reader: Mutex::new(reader),
        workspace: Mutex::new(workspace.clone()),
        assets: Mutex::new(assets),
        thumb_meta: Mutex::new(HashMap::new()),
    })
}

fn row_to_node(row: &Row<'_>) -> rusqlite::Result<SceneNode> {
    Ok(SceneNode {
        id: row.get(0)?,
        kind: row.get(1)?,
        icon: row.get(2)?,
        name: row.get(3)?,
        subtitle: row.get(4)?,
        body: row.get(5)?,
        group_id: row.get(6)?,
        z: row.get(7)?,
        parent_node_id: row.get(8)?,
        data_json: row.get(9)?,
        x: row.get(10)?,
        y: row.get(11)?,
        w: row.get(12)?,
        h: row.get(13)?,
        is_exists: row.get(14)?,
        thumb_key: row.get(15)?,
        path: row.get(16)?,
        url: row.get(17)?,
    })
}

/// 节点查询模板：节点字段来自 `nodes`，`is_exists` / `thumb_key` / `path` / `url`
/// 来自关联的 `refs`。统一使用它可避免各处 SELECT 字段顺序与 `row_to_node` 错位。
const NODE_SELECT: &str = r#"
    SELECT n.id, n.type, n.icon, n.name, n.subtitle, n.body, n.group_id, n.z,
           n.parent_node_id, n.data_json, n.x, n.y, n.w, n.h,
           COALESCE(r.is_exists, 1), r.thumb_key, r.path, r.url
    FROM nodes n
    LEFT JOIN refs r ON r.id = n.ref_id
"#;

fn load_node_by_id(connection: &Connection, node_id: &str) -> rusqlite::Result<Option<SceneNode>> {
    connection
        .query_row(
            &format!("{NODE_SELECT} WHERE n.id = ?1 LIMIT 1"),
            params![node_id],
            row_to_node,
        )
        .optional()
}

/// 读取完整场景：节点、连线、标注分三次查询，避免 N+1 与笛卡尔积。
/// 标注目标用 `GROUP_CONCAT` 聚合，无目标的标注直接丢弃。
/// 走只读连接：一次拿完，不与操作结束后的保存事务抢锁。
pub fn scene_load(state: &AppState) -> Result<SceneData, String> {
    let connection = state.reader.lock().map_err(|error| error.to_string())?;

    let mut node_statement = connection
        .prepare(NODE_SELECT)
        .map_err(|error| format!("读取节点失败：{error}"))?;
    let nodes = node_statement
        .query_map([], row_to_node)
        .map_err(|error| format!("读取节点失败：{error}"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("读取节点失败：{error}"))?;
    drop(node_statement);

    let mut group_statement = connection
        .prepare("SELECT id, title, color, x, y, w, h FROM groups")
        .map_err(|error| format!("读取分组失败：{error}"))?;
    let groups = group_statement
        .query_map([], |row| {
            Ok(crate::models::SceneGroup {
                id: row.get(0)?,
                title: row.get(1)?,
                color: row.get(2)?,
                x: row.get(3)?,
                y: row.get(4)?,
                w: row.get(5)?,
                h: row.get(6)?,
            })
        })
        .map_err(|error| format!("读取分组失败：{error}"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("读取分组失败：{error}"))?;
    drop(group_statement);

    let mut edge_statement = connection
        .prepare(
            "SELECT id, from_node, to_node, from_handle, to_handle, label, style_json FROM edges",
        )
        .map_err(|error| format!("读取连线失败：{error}"))?;
    let edges = edge_statement
        .query_map([], |row| {
            Ok(SceneEdge {
                id: row.get(0)?,
                from: row.get(1)?,
                to: row.get(2)?,
                from_handle: row.get(3)?,
                to_handle: row.get(4)?,
                label: row.get(5)?,
                style_json: row.get(6)?,
            })
        })
        .map_err(|error| format!("读取连线失败：{error}"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("读取连线失败：{error}"))?;
    drop(edge_statement);

    let mut annotation_statement = connection
        .prepare(
            r#"
            SELECT a.id, a.color, a.text, GROUP_CONCAT(t.node_id, '|')
            FROM annotations a
            LEFT JOIN annotation_targets t ON t.annotation_id = a.id
            GROUP BY a.id
            "#,
        )
        .map_err(|error| format!("读取标注失败：{error}"))?;
    let annotations = annotation_statement
        .query_map([], |row| {
            let targets: Option<String> = row.get(3)?;
            Ok(SceneAnnotation {
                id: row.get(0)?,
                color: row.get(1)?,
                text: row.get(2)?,
                node_ids: targets
                    .unwrap_or_default()
                    .split('|')
                    .filter(|value| !value.is_empty())
                    .map(|value| value.to_string())
                    .collect(),
            })
        })
        .map_err(|error| format!("读取标注失败：{error}"))?
        .filter_map(|result| result.ok())
        .filter(|annotation| !annotation.node_ids.is_empty())
        .collect::<Vec<_>>();

    Ok(SceneData {
        nodes,
        groups,
        edges,
        annotations,
    })
}

fn ref_kind(node: &SceneNode) -> &'static str {
    if node.kind == "folder" {
        "folder"
    } else if node.kind == "link" {
        "link"
    } else {
        "file"
    }
}

/// 节点可变字段指纹：与 upsert 的列一一对应（`created_at` / `updated_at` 不参与比较），
/// 用于增量保存时跳过未变化的行。
type NodeFingerprint = (
    String,         // type
    String,         // icon
    String,         // name
    String,         // subtitle
    Option<String>, // body
    String,         // group_id
    i64,            // z
    Option<String>, // parent_node_id
    Option<String>, // data_json
    f64,            // x
    f64,            // y
    f64,            // w
    f64,            // h
);

/// 引用可变字段指纹；`size` / `mtime` / `is_exists` / `thumb_key` 由导入与校验维护，不参与比较。
type RefFingerprint = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
    String,
);

fn read_node_fingerprints(
    connection: &Connection,
) -> rusqlite::Result<HashMap<String, NodeFingerprint>> {
    let mut statement = connection.prepare(
        "SELECT id, type, icon, name, subtitle, body, group_id, z,
                parent_node_id, data_json, x, y, w, h
         FROM nodes",
    )?;
    let mut rows = statement.query([])?;
    let mut map = HashMap::new();
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        map.insert(
            id,
            (
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
                row.get(10)?,
                row.get(11)?,
                row.get(12)?,
                row.get(13)?,
            ),
        );
    }
    Ok(map)
}

fn node_matches(fingerprint: &NodeFingerprint, node: &SceneNode) -> bool {
    fingerprint.0 == node.kind
        && fingerprint.1 == node.icon
        && fingerprint.2 == node.name
        && fingerprint.3 == node.subtitle
        && fingerprint.4.as_deref() == node.body.as_deref()
        && fingerprint.5 == node.group_id
        && fingerprint.6 == node.z
        && fingerprint.7.as_deref() == node.parent_node_id.as_deref()
        && fingerprint.8.as_deref() == node.data_json.as_deref()
        && fingerprint.9 == node.x
        && fingerprint.10 == node.y
        && fingerprint.11 == node.w
        && fingerprint.12 == node.h
}

fn read_ref_fingerprints(
    connection: &Connection,
) -> rusqlite::Result<HashMap<String, RefFingerprint>> {
    let mut statement = connection
        .prepare("SELECT id, kind, dedupe_key, path, url, name, ext, search_text FROM refs")?;
    let mut rows = statement.query([])?;
    let mut map = HashMap::new();
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        map.insert(
            id,
            (
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
            ),
        );
    }
    Ok(map)
}

/// 引用行是否与节点派生字段一致（字段与 `upsert_ref_for_node` 同源）。
fn ref_matches(fingerprint: &RefFingerprint, node: &SceneNode) -> bool {
    let kind = ref_kind(node);
    let path = node.path.clone();
    let url = node.url.clone();
    let dedupe_key = path
        .as_ref()
        .filter(|_| kind == "file" || kind == "folder")
        .map(|value| normalize_path_key(Path::new(value)));
    let ext = ext_of(path.as_ref());
    let search_text = format!(
        "{} {} {}",
        node.name,
        path.clone().unwrap_or_default(),
        node.subtitle
    );
    fingerprint.0 == kind
        && fingerprint.1.as_deref() == dedupe_key.as_deref()
        && fingerprint.2.as_deref() == path.as_deref()
        && fingerprint.3.as_deref() == url.as_deref()
        && fingerprint.4 == node.name
        && fingerprint.5.as_deref() == ext.as_deref()
        && fingerprint.6 == search_text
}

fn ext_of(path: Option<&String>) -> Option<String> {
    path.and_then(|value| Path::new(value).extension())
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
}

// ---------- 保存语句（全量快照与增量共用，避免两处 SQL 漂移） ----------
// refs 的 size / mtime / is_exists / thumb_key 由导入与校验维护：UPDATE 永不覆盖这些列。

const REF_UPSERT_SQL: &str = r#"
    INSERT INTO refs
        (id, kind, dedupe_key, path, url, name, ext, size, mtime,
         is_exists, thumb_key, search_text, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, 1, NULL, ?8, ?9, ?9)
    ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        dedupe_key = excluded.dedupe_key,
        path = excluded.path,
        url = excluded.url,
        name = excluded.name,
        ext = excluded.ext,
        search_text = excluded.search_text,
        updated_at = excluded.updated_at
"#;

const NODE_UPSERT_SQL: &str = r#"
    INSERT INTO nodes
        (id, type, icon, name, subtitle, body, ref_id, group_id,
         z, parent_node_id, data_json, x, y, w, h, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)
    ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        icon = excluded.icon,
        name = excluded.name,
        subtitle = excluded.subtitle,
        body = excluded.body,
        ref_id = excluded.ref_id,
        group_id = excluded.group_id,
        z = excluded.z,
        parent_node_id = excluded.parent_node_id,
        data_json = excluded.data_json,
        x = excluded.x,
        y = excluded.y,
        w = excluded.w,
        h = excluded.h,
        updated_at = excluded.updated_at
"#;

const GROUP_UPSERT_SQL: &str = r#"
    INSERT INTO groups (id, title, color, x, y, w, h, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
    ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        color = excluded.color,
        x = excluded.x,
        y = excluded.y,
        w = excluded.w,
        h = excluded.h,
        updated_at = excluded.updated_at
"#;

const EDGE_UPSERT_SQL: &str = r#"
    INSERT INTO edges
        (id, from_node, to_node, from_handle, to_handle, label, style_json, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    ON CONFLICT(id) DO UPDATE SET
        from_node = excluded.from_node,
        to_node = excluded.to_node,
        from_handle = excluded.from_handle,
        to_handle = excluded.to_handle,
        label = excluded.label,
        style_json = excluded.style_json
"#;

const ANNOTATION_UPSERT_SQL: &str = r#"
    INSERT INTO annotations (id, color, text, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?4)
    ON CONFLICT(id) DO UPDATE SET
        color = excluded.color,
        text = excluded.text,
        updated_at = excluded.updated_at
"#;

const TARGET_CLEAR_SQL: &str = "DELETE FROM annotation_targets WHERE annotation_id = ?1";
const TARGET_ADD_SQL: &str =
    "INSERT OR IGNORE INTO annotation_targets (annotation_id, node_id) VALUES (?1, ?2)";

/// 按节点的引用信息写 refs 行；无 path/url 的纯画布对象（文字）不产生引用。
fn upsert_ref_for_node(
    statement: &mut rusqlite::Statement<'_>,
    node: &SceneNode,
    timestamp: i64,
) -> rusqlite::Result<()> {
    let kind = ref_kind(node);
    let path = node.path.clone();
    let url = node.url.clone();
    let dedupe_key = path
        .as_ref()
        .filter(|_| kind == "file" || kind == "folder")
        .map(|value| normalize_path_key(Path::new(value)));
    let ext = ext_of(path.as_ref());
    let search_text = format!(
        "{} {} {}",
        node.name,
        path.clone().unwrap_or_default(),
        node.subtitle
    );
    statement.execute(params![
        &node.id,
        kind,
        &dedupe_key,
        &path,
        &url,
        &node.name,
        &ext,
        &search_text,
        timestamp
    ])?;
    Ok(())
}

/// 按节点写 nodes 行；`ref_id` 与 refs 的存在性保持一致（有 path/url 才指向引用）。
fn upsert_node_row(
    statement: &mut rusqlite::Statement<'_>,
    node: &SceneNode,
    timestamp: i64,
) -> rusqlite::Result<()> {
    let ref_id = if node.path.is_some() || node.url.is_some() {
        Some(node.id.clone())
    } else {
        None
    };
    statement.execute(params![
        &node.id,
        &node.kind,
        &node.icon,
        &node.name,
        &node.subtitle,
        &node.body,
        &ref_id,
        &node.group_id,
        node.z,
        &node.parent_node_id,
        &node.data_json,
        node.x,
        node.y,
        node.w,
        node.h,
        timestamp
    ])?;
    Ok(())
}

/// 增量保存完整场景：按 ID upsert，事务内只清理本次快照里已不存在的对象。
/// `refs` 的 `size` / `mtime` / `thumb_key` / `is_exists` 由导入与校验流程维护，
/// 自动保存只更新引用本身变化的字段，避免每次拖动都把元数据抹掉。
pub fn scene_save(state: &AppState, scene: &SceneData) -> Result<(), String> {
    let mut connection = state.db.lock().map_err(|error| error.to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开启事务失败：{error}"))?;

    // 连接级临时表记录本次快照包含的 ID；每次保存先清空，用于事后清理已删除对象。
    transaction
        .execute_batch(
            r#"
            CREATE TEMP TABLE IF NOT EXISTS keep_nodes (id TEXT PRIMARY KEY);
            CREATE TEMP TABLE IF NOT EXISTS keep_groups (id TEXT PRIMARY KEY);
            CREATE TEMP TABLE IF NOT EXISTS keep_edges (id TEXT PRIMARY KEY);
            CREATE TEMP TABLE IF NOT EXISTS keep_annotations (id TEXT PRIMARY KEY);
            DELETE FROM keep_nodes;
            DELETE FROM keep_groups;
            DELETE FROM keep_edges;
            DELETE FROM keep_annotations;
            "#,
        )
        .map_err(|error| format!("准备保存临时表失败：{error}"))?;

    let timestamp = now_ms();

    {
        let mut upsert_ref = transaction
            .prepare(REF_UPSERT_SQL)
            .map_err(|error| format!("准备保存引用失败：{error}"))?;
        let mut upsert_node = transaction
            .prepare(NODE_UPSERT_SQL)
            .map_err(|error| format!("准备保存节点失败：{error}"))?;
        let mut keep_node = transaction
            .prepare("INSERT OR IGNORE INTO keep_nodes (id) VALUES (?1)")
            .map_err(|error| format!("准备保存节点清单失败：{error}"))?;

        // 指纹对比：先读现有 nodes/refs 的可变字段，只 upsert 真正变化的行。
        // 10 万画布的常规保存（拖一个节点落定后写一次）从「约 20 万次 upsert」
        // 降到个位数，写事务从秒级降到几十毫秒，不再长时间持有写锁。
        let existing_nodes = read_node_fingerprints(&transaction)
            .map_err(|error| format!("读取现有节点失败：{error}"))?;
        let existing_refs = read_ref_fingerprints(&transaction)
            .map_err(|error| format!("读取现有引用失败：{error}"))?;

        for node in &scene.nodes {
            let unchanged = existing_nodes
                .get(&node.id)
                .is_some_and(|fingerprint| node_matches(fingerprint, node));

            if !unchanged {
                upsert_node_row(&mut upsert_node, node, timestamp)
                    .map_err(|error| format!("保存节点失败：{error}"))?;
            }
            keep_node
                .execute(params![&node.id])
                .map_err(|error| format!("记录节点失败：{error}"))?;

            if node.path.is_some() || node.url.is_some() {
                // 引用字段与节点同源：节点没变时引用通常也没变，缺失才补写。
                let ref_same = existing_refs
                    .get(&node.id)
                    .is_some_and(|fingerprint| ref_matches(fingerprint, node));
                if !ref_same {
                    upsert_ref_for_node(&mut upsert_ref, node, timestamp)
                        .map_err(|error| format!("保存引用失败：{error}"))?;
                }
            }
        }
    }

    {
        let mut upsert_group = transaction
            .prepare(GROUP_UPSERT_SQL)
            .map_err(|error| format!("准备保存分组失败：{error}"))?;
        let mut keep_group = transaction
            .prepare("INSERT OR IGNORE INTO keep_groups (id) VALUES (?1)")
            .map_err(|error| format!("准备保存分组清单失败：{error}"))?;

        for group in &scene.groups {
            upsert_group
                .execute(params![
                    &group.id,
                    &group.title,
                    &group.color,
                    group.x,
                    group.y,
                    group.w,
                    group.h,
                    timestamp
                ])
                .map_err(|error| format!("保存分组失败：{error}"))?;
            keep_group
                .execute(params![&group.id])
                .map_err(|error| format!("记录分组失败：{error}"))?;
        }
    }

    {
        let mut upsert_edge = transaction
            .prepare(EDGE_UPSERT_SQL)
            .map_err(|error| format!("准备保存连线失败：{error}"))?;
        let mut keep_edge = transaction
            .prepare("INSERT OR IGNORE INTO keep_edges (id) VALUES (?1)")
            .map_err(|error| format!("准备保存连线清单失败：{error}"))?;

        for edge in &scene.edges {
            upsert_edge
                .execute(params![
                    &edge.id,
                    &edge.from,
                    &edge.to,
                    &edge.from_handle,
                    &edge.to_handle,
                    &edge.label,
                    &edge.style_json,
                    timestamp
                ])
                .map_err(|error| format!("保存连线失败：{error}"))?;
            keep_edge
                .execute(params![&edge.id])
                .map_err(|error| format!("记录连线失败：{error}"))?;
        }
    }

    {
        let mut upsert_annotation = transaction
            .prepare(ANNOTATION_UPSERT_SQL)
            .map_err(|error| format!("准备保存标注失败：{error}"))?;
        let mut keep_annotation = transaction
            .prepare("INSERT OR IGNORE INTO keep_annotations (id) VALUES (?1)")
            .map_err(|error| format!("准备保存标注清单失败：{error}"))?;
        let mut clear_targets = transaction
            .prepare(TARGET_CLEAR_SQL)
            .map_err(|error| format!("准备清理标注目标失败：{error}"))?;
        let mut add_target = transaction
            .prepare(TARGET_ADD_SQL)
            .map_err(|error| format!("准备保存标注目标失败：{error}"))?;

        for annotation in &scene.annotations {
            upsert_annotation
                .execute(params![
                    &annotation.id,
                    &annotation.color,
                    &annotation.text,
                    timestamp
                ])
                .map_err(|error| format!("保存标注失败：{error}"))?;
            keep_annotation
                .execute(params![&annotation.id])
                .map_err(|error| format!("记录标注失败：{error}"))?;
            // 目标集合可能缩小，先清空再写入本次快照的目标。
            clear_targets
                .execute(params![&annotation.id])
                .map_err(|error| format!("清理标注目标失败：{error}"))?;
            for node_id in &annotation.node_ids {
                add_target
                    .execute(params![&annotation.id, node_id])
                    .map_err(|error| format!("保存标注目标失败：{error}"))?;
            }
        }
    }

    // 清理本次快照之外的对象；连线若指向已删除节点也一并移除。
    transaction
        .execute_batch(
            r#"
            DELETE FROM edges
            WHERE id NOT IN (SELECT id FROM keep_edges)
               OR from_node NOT IN (SELECT id FROM nodes)
               OR to_node NOT IN (SELECT id FROM nodes);
            DELETE FROM nodes WHERE id NOT IN (SELECT id FROM keep_nodes);
            DELETE FROM groups WHERE id NOT IN (SELECT id FROM keep_groups);
            UPDATE nodes SET group_id = ''
            WHERE group_id <> '' AND group_id NOT IN (SELECT id FROM groups);
            DELETE FROM annotation_targets
            WHERE annotation_id NOT IN (SELECT id FROM keep_annotations)
               OR node_id NOT IN (SELECT id FROM nodes);
            DELETE FROM annotations WHERE id NOT IN (SELECT id FROM keep_annotations);
            DELETE FROM refs WHERE id NOT IN (SELECT ref_id FROM nodes WHERE ref_id IS NOT NULL);
            "#,
        )
        .map_err(|error| format!("清理已删除对象失败：{error}"))?;

    transaction
        .commit()
        .map_err(|error| format!("提交场景失败：{error}"))?;
    Ok(())
}

/// 增量保存：只 upsert 传入的行、按 ID 删除显式移除的行。
/// 与全量快照的「快照外清理」互补——删除靠前端显式 ID 列表；收尾对 refs 与
/// 悬空边/标注目标做一次兜底清理（仅在真有删除时执行），防前端遗漏造成数据漂移。
pub fn scene_save_delta(state: &AppState, delta: &SceneDelta) -> Result<(), String> {
    let mut connection = state.db.lock().map_err(|error| error.to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开启事务失败：{error}"))?;
    let timestamp = now_ms();

    {
        let mut upsert_ref = transaction
            .prepare(REF_UPSERT_SQL)
            .map_err(|error| format!("准备保存引用失败：{error}"))?;
        let mut upsert_node = transaction
            .prepare(NODE_UPSERT_SQL)
            .map_err(|error| format!("准备保存节点失败：{error}"))?;
        let mut delete_node = transaction
            .prepare("DELETE FROM nodes WHERE id = ?1")
            .map_err(|error| format!("准备删除节点失败：{error}"))?;

        for node in &delta.nodes {
            if node.path.is_some() || node.url.is_some() {
                upsert_ref_for_node(&mut upsert_ref, node, timestamp)
                    .map_err(|error| format!("保存引用失败：{error}"))?;
            }
            upsert_node_row(&mut upsert_node, node, timestamp)
                .map_err(|error| format!("保存节点失败：{error}"))?;
        }
        for id in &delta.removed_node_ids {
            delete_node
                .execute(params![id])
                .map_err(|error| format!("删除节点失败：{error}"))?;
        }
    }

    {
        let mut upsert_group = transaction
            .prepare(GROUP_UPSERT_SQL)
            .map_err(|error| format!("准备保存分组失败：{error}"))?;
        let mut delete_group = transaction
            .prepare("DELETE FROM groups WHERE id = ?1")
            .map_err(|error| format!("准备删除分组失败：{error}"))?;

        for group in &delta.groups {
            upsert_group
                .execute(params![
                    &group.id,
                    &group.title,
                    &group.color,
                    group.x,
                    group.y,
                    group.w,
                    group.h,
                    timestamp
                ])
                .map_err(|error| format!("保存分组失败：{error}"))?;
        }
        for id in &delta.removed_group_ids {
            delete_group
                .execute(params![id])
                .map_err(|error| format!("删除分组失败：{error}"))?;
        }
    }

    {
        let mut upsert_edge = transaction
            .prepare(EDGE_UPSERT_SQL)
            .map_err(|error| format!("准备保存连线失败：{error}"))?;
        let mut delete_edge = transaction
            .prepare("DELETE FROM edges WHERE id = ?1")
            .map_err(|error| format!("准备删除连线失败：{error}"))?;

        for edge in &delta.edges {
            upsert_edge
                .execute(params![
                    &edge.id,
                    &edge.from,
                    &edge.to,
                    &edge.from_handle,
                    &edge.to_handle,
                    &edge.label,
                    &edge.style_json,
                    timestamp
                ])
                .map_err(|error| format!("保存连线失败：{error}"))?;
        }
        for id in &delta.removed_edge_ids {
            delete_edge
                .execute(params![id])
                .map_err(|error| format!("删除连线失败：{error}"))?;
        }
    }

    {
        let mut upsert_annotation = transaction
            .prepare(ANNOTATION_UPSERT_SQL)
            .map_err(|error| format!("准备保存标注失败：{error}"))?;
        let mut clear_targets = transaction
            .prepare(TARGET_CLEAR_SQL)
            .map_err(|error| format!("准备清理标注目标失败：{error}"))?;
        let mut add_target = transaction
            .prepare(TARGET_ADD_SQL)
            .map_err(|error| format!("准备保存标注目标失败：{error}"))?;
        let mut delete_annotation = transaction
            .prepare("DELETE FROM annotations WHERE id = ?1")
            .map_err(|error| format!("准备删除标注失败：{error}"))?;

        for annotation in &delta.annotations {
            upsert_annotation
                .execute(params![
                    &annotation.id,
                    &annotation.color,
                    &annotation.text,
                    timestamp
                ])
                .map_err(|error| format!("保存标注失败：{error}"))?;
            // 目标集合可能缩小，先清空再写入本次快照的目标。
            clear_targets
                .execute(params![&annotation.id])
                .map_err(|error| format!("清理标注目标失败：{error}"))?;
            for node_id in &annotation.node_ids {
                add_target
                    .execute(params![&annotation.id, node_id])
                    .map_err(|error| format!("保存标注目标失败：{error}"))?;
            }
        }
        for id in &delta.removed_annotation_ids {
            delete_annotation
                .execute(params![id])
                .map_err(|error| format!("删除标注失败：{error}"))?;
        }
    }

    // 兜底清理只在真有删除时执行（全表扫描有成本）：删除的节点会带出悬空 refs、
    // 边与标注目标；前端删除逻辑已同步处理，这里防遗漏漂移。
    if !delta.removed_node_ids.is_empty() {
        transaction
            .execute_batch(
                r#"
                DELETE FROM refs WHERE id NOT IN (SELECT ref_id FROM nodes WHERE ref_id IS NOT NULL);
                DELETE FROM edges
                WHERE from_node NOT IN (SELECT id FROM nodes)
                   OR to_node NOT IN (SELECT id FROM nodes);
                DELETE FROM annotation_targets WHERE node_id NOT IN (SELECT id FROM nodes);
                "#,
            )
            .map_err(|error| format!("增量清理失败：{error}"))?;
    }

    transaction
        .commit()
        .map_err(|error| format!("提交增量失败：{error}"))?;
    Ok(())
}

/// 批量导入绝对路径：
/// - 用 `symlink_metadata` 拒绝符号链接，再 `canonicalize` 得到真实路径；
/// - 文件/文件夹按 `(kind, dedupe_key)` 去重，命中的节点进入 `existing`；
/// - 失败项带路径与原因进入 `errors`，不允许静默跳过（HC-14）。
pub fn import_paths(state: &AppState, request: &ImportRequest) -> Result<ImportResult, String> {
    let mut connection = state.db.lock().map_err(|error| error.to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开启事务失败：{error}"))?;

    let mut created = Vec::new();
    let mut existing = Vec::new();
    let mut errors = Vec::new();
    let timestamp = now_ms();

    for (index, raw_path) in request.paths.iter().enumerate() {
        let link_metadata = match fs::symlink_metadata(raw_path) {
            Ok(metadata) => metadata,
            Err(error) => {
                errors.push(ImportError {
                    path: raw_path.clone(),
                    reason: format!("路径不存在或无法访问：{error}"),
                });
                continue;
            }
        };
        if link_metadata.file_type().is_symlink() {
            errors.push(ImportError {
                path: raw_path.clone(),
                reason: "不支持符号链接，请拖入目标文件本身".to_string(),
            });
            continue;
        }

        let canonical = match fs::canonicalize(raw_path) {
            Ok(path) => path,
            Err(error) => {
                errors.push(ImportError {
                    path: raw_path.clone(),
                    reason: format!("路径不存在或无法访问：{error}"),
                });
                continue;
            }
        };

        let metadata = match fs::metadata(&canonical) {
            Ok(metadata) => metadata,
            Err(error) => {
                errors.push(ImportError {
                    path: raw_path.clone(),
                    reason: format!("读取文件信息失败：{error}"),
                });
                continue;
            }
        };

        let (kind, icon) = file_icon_and_kind(&canonical);
        let dedupe_key = normalize_path_key(&canonical);
        let existing_node: Option<SceneNode> = transaction
            .query_row(
                &format!(
                    "{NODE_SELECT} WHERE r.dedupe_key = ?1 AND r.kind IN ('file','folder') LIMIT 1"
                ),
                params![&dedupe_key],
                row_to_node,
            )
            .optional()
            .map_err(|error| format!("查询重复文件失败：{error}"))?;

        if let Some(mut node) = existing_node {
            // 旧版本可能把快捷方式记成文本文档；导入时刷新类型与图标，避免继续显示通用图标。
            if node.kind != kind || node.icon != icon {
                transaction
                    .execute(
                        "UPDATE nodes SET type = ?2, icon = ?3, updated_at = ?4 WHERE id = ?1",
                        params![&node.id, kind, icon, timestamp],
                    )
                    .map_err(|error| format!("刷新节点图标失败：{error}"))?;
                node.kind = kind.to_string();
                node.icon = icon.to_string();
            }
            existing.push(node);
            continue;
        }

        let name = canonical
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| raw_path.clone());
        let subtitle = subtitle_for_path(&canonical);
        let path = clean_path(&canonical);
        let node_id = Uuid::new_v4().to_string();
        // 72×64 图标格 + 8px 间距；一行 8 个，与桌面网格一致。
        let x = request.x + (index % 8) as f64 * 80.0;
        let y = request.y + (index / 8) as f64 * 72.0;
        let ref_kind = if kind == "folder" { "folder" } else { "file" };
        let ext = ext_of(Some(&path));
        let size = metadata.len() as i64;
        let mtime = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64);
        let search_text = format!("{name} {path} {subtitle}");

        transaction
            .execute(
                r#"
                INSERT INTO refs
                    (id, kind, dedupe_key, path, url, name, ext, size, mtime,
                     is_exists, thumb_key, search_text, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, 1, NULL, ?9, ?10, ?10)
                "#,
                params![
                    &node_id,
                    ref_kind,
                    &dedupe_key,
                    &path,
                    &name,
                    &ext,
                    size,
                    mtime,
                    &search_text,
                    timestamp
                ],
            )
            .map_err(|error| format!("写入引用失败：{error}"))?;

        let node = SceneNode {
            id: node_id.clone(),
            kind: kind.to_string(),
            icon: icon.to_string(),
            name,
            path: Some(path),
            subtitle,
            body: None,
            url: None,
            group_id: String::new(),
            z: 0,
            parent_node_id: None,
            data_json: None,
            x,
            y,
            w: 72.0,
            h: 64.0,
            is_exists: true,
            thumb_key: None,
        };

        transaction
            .execute(
                r#"
                INSERT INTO nodes
                    (id, type, icon, name, subtitle, body, ref_id, group_id,
                     x, y, w, h, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?1, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
                "#,
                params![
                    &node.id,
                    &node.kind,
                    &node.icon,
                    &node.name,
                    &node.subtitle,
                    &node.group_id,
                    node.x,
                    node.y,
                    node.w,
                    node.h,
                    timestamp
                ],
            )
            .map_err(|error| format!("写入节点失败：{error}"))?;

        created.push(node);
    }

    transaction
        .commit()
        .map_err(|error| format!("提交导入失败：{error}"))?;

    Ok(ImportResult {
        created,
        existing,
        errors,
    })
}

/// 递归统计目录占用；读取失败的条目跳过，不影响主流程。
fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| match entry.metadata() {
            Ok(metadata) if metadata.is_dir() => dir_size(&entry.path()),
            Ok(metadata) => metadata.len(),
            Err(_) => 0,
        })
        .sum()
}

/// 工作空间信息：路径、数据库文件位置、节点总数与各部分占用。
pub fn workspace_info(state: &AppState) -> Result<WorkspaceInfo, String> {
    let workspace = state.workspace_path()?;
    let assets = state.assets_path()?;

    let connection = state.reader.lock().map_err(|error| error.to_string())?;
    let node_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM nodes", [], |row| row.get(0))
        .unwrap_or(0);
    drop(connection);

    let db_path = workspace.join("ploceus.db");

    Ok(WorkspaceInfo {
        path: workspace.to_string_lossy().to_string(),
        db_path: db_path.to_string_lossy().to_string(),
        node_count,
        size_bytes: dir_size(&workspace),
        db_bytes: fs::metadata(&db_path).map(|meta| meta.len()).unwrap_or(0),
        assets_bytes: dir_size(&assets),
        thumbnail_bytes: dir_size(&workspace.join("thumbnails")),
    })
}

/// 查询节点的打开目标（文件路径 / URL）；打开与定位命令只接受 `nodeId`，不接受任意路径。
pub fn node_target(
    state: &AppState,
    node_id: &str,
) -> Result<(Option<String>, Option<String>), String> {
    let connection = state.reader.lock().map_err(|error| error.to_string())?;
    connection
        .query_row(
            r#"
            SELECT r.path, r.url
            FROM nodes n
            LEFT JOIN refs r ON r.id = n.ref_id
            WHERE n.id = ?1
            "#,
            params![node_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("查询引用失败：{error}"))?
        .ok_or_else(|| "引用不存在".to_string())
}

/// 将截图写入 assets 目录，文件名用 UUID 避免冲突；返回落盘绝对路径。
pub fn save_asset(state: &AppState, bytes: &[u8], ext: &str) -> Result<String, String> {
    let assets = state.assets_path()?;
    fs::create_dir_all(&assets).map_err(|error| format!("创建 assets 失败：{error}"))?;
    let path = assets.join(format!("{}.{}", Uuid::new_v4(), ext));
    fs::write(&path, bytes).map_err(|error| format!("写入截图失败：{error}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 富文本媒体扩展名白名单：图片 + WebView2 可直接播放的视频格式。
const RICH_MEDIA_EXTS: [&str; 9] = [
    "png", "jpg", "jpeg", "webp", "gif", "bmp", "mp4", "webm", "ogg",
];

/// 富文本媒体扩展名校验；白名单外直接拒绝，不做静默降级。
pub fn is_rich_media_ext(ext: &str) -> bool {
    RICH_MEDIA_EXTS.contains(&ext)
}

/// 保存富文本媒体：body = `[ext_len: u8][ext ascii][文件字节]`（Raw IPC 二进制体，不经 base64）。
/// 文件名由 UUID 生成，返回 `assets/<文件名>` 相对引用；HTML 只存相对引用，
/// 工作空间迁移后无需改写（HC-12：不传路径，扩展名走白名单）。
pub fn save_rich_asset(state: &AppState, body: &[u8]) -> Result<String, String> {
    let ext_len = *body.first().ok_or("媒体上传体为空")? as usize;
    let ext = std::str::from_utf8(body.get(1..1 + ext_len).ok_or("媒体上传体不完整")?)
        .map_err(|_| "媒体扩展名必须是 ASCII")?
        .to_lowercase();
    if !is_rich_media_ext(&ext) {
        return Err(format!("不支持的媒体格式：{ext}"));
    }
    let file = body.get(1 + ext_len..).ok_or("媒体上传体不完整")?;
    let limit = if matches!(ext.as_str(), "mp4" | "webm" | "ogg") {
        100 * 1024 * 1024
    } else {
        20 * 1024 * 1024
    };
    if file.is_empty() || file.len() > limit {
        return Err(format!("媒体文件须非空且不超过 {}MB", limit / 1024 / 1024));
    }
    let assets = state.assets_path()?;
    fs::create_dir_all(&assets)
        .map_err(|error| format!("{}：创建媒体目录失败：{error}", assets.display()))?;
    let assets = rich_assets_root(state)?;
    let name = format!("{}.{}", Uuid::new_v4(), ext);
    let path = assets.join(&name);
    fs::write(&path, file)
        .map_err(|error| format!("{}：写入媒体文件失败：{error}", path.display()))?;
    Ok(format!("assets/{name}"))
}

/// 解析富文本媒体文件名为 assets 目录下的绝对路径；
/// 文件名必须是白名单扩展名，且拒绝路径分隔符与编码字符，防目录穿越。
pub fn rich_asset_file(state: &AppState, name: &str) -> Result<PathBuf, String> {
    let ext = name.rsplit('.').next().unwrap_or("");
    if name.is_empty()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_'))
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.contains('%')
        || !is_rich_media_ext(ext)
    {
        return Err("非法的媒体文件名".to_string());
    }
    let root = rich_assets_root(state)?;
    let path = root.join(name);
    let resolved = fs::canonicalize(&path)
        .map_err(|error| format!("{}：解析媒体路径失败：{error}", path.display()))?;
    if !resolved.starts_with(&root) {
        return Err(format!(
            "{}：读取媒体被拒绝：真实路径越出 assets",
            path.display()
        ));
    }
    Ok(resolved)
}

/// 资产目录自身也可能被替换成链接，读写前均要求真实目录留在当前工作空间内。
fn rich_assets_root(state: &AppState) -> Result<PathBuf, String> {
    let assets = state.assets_path()?;
    let root = fs::canonicalize(&assets)
        .map_err(|error| format!("{}：解析媒体目录失败：{error}", assets.display()))?;
    let workspace = state.workspace_path()?;
    let workspace = fs::canonicalize(&workspace)
        .map_err(|error| format!("{}：解析工作空间失败：{error}", workspace.display()))?;
    if !root.starts_with(workspace) {
        return Err(format!(
            "{}：媒体读写被拒绝：真实目录越出工作空间",
            assets.display()
        ));
    }
    Ok(root)
}

// ---------- 应用配置 ----------

/// 读取应用配置；键不存在或数据库异常时返回 `None`，由调用方回退默认值。
pub fn meta_get(state: &AppState, key: &str) -> Result<Option<String>, String> {
    let connection = state.reader.lock().map_err(|error| error.to_string())?;
    connection
        .query_row(
            "SELECT value FROM app_meta WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("读取配置失败：{error}"))
}

/// 写入应用配置；只存值本身，不存整套令牌。
pub fn meta_set(state: &AppState, key: &str, value: &str) -> Result<(), String> {
    let connection = state.db.lock().map_err(|error| error.to_string())?;
    connection
        .execute(
            r#"
            INSERT INTO app_meta (key, value) VALUES (?1, ?2)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            "#,
            params![key, value],
        )
        .map_err(|error| format!("保存配置失败：{error}"))?;
    Ok(())
}

// ---------- 引用校验与重新关联 ----------

/// 读取需要校验的节点：`node_ids` 为空表示全部有路径的节点。
fn nodes_for_check(connection: &Connection, node_ids: &[String]) -> Result<Vec<SceneNode>, String> {
    if node_ids.is_empty() {
        let mut statement = connection
            .prepare(&format!("{NODE_SELECT} WHERE r.path IS NOT NULL"))
            .map_err(|error| format!("读取引用失败：{error}"))?;
        return statement
            .query_map([], row_to_node)
            .map_err(|error| format!("读取引用失败：{error}"))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("读取引用失败：{error}"));
    }

    let mut nodes = Vec::new();
    for node_id in node_ids {
        if let Some(node) = load_node_by_id(connection, node_id)
            .map_err(|error| format!("读取引用失败：{error}"))?
        {
            nodes.push(node);
        }
    }
    Ok(nodes)
}

/// 批量校验引用是否仍存在：拒绝符号链接，写回 `is_exists` / `size` / `mtime`。
/// 文字与链接卡片没有磁盘路径，直接跳过。
pub fn ref_check(state: &AppState, node_ids: &[String]) -> Result<Vec<RefStatus>, String> {
    let mut connection = state.db.lock().map_err(|error| error.to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开启事务失败：{error}"))?;
    let nodes = nodes_for_check(&transaction, node_ids)?;
    let timestamp = now_ms();
    let mut statuses = Vec::new();

    {
        let mut update = transaction
            .prepare(
                r#"
                UPDATE refs SET is_exists = ?2, size = ?3, mtime = ?4, updated_at = ?5
                WHERE id = (SELECT ref_id FROM nodes WHERE id = ?1)
                "#,
            )
            .map_err(|error| format!("准备校验引用失败：{error}"))?;

        for node in nodes {
            let Some(path) = node.path.clone() else {
                continue;
            };
            if node.kind == "link" {
                continue;
            }

            let exists = fs::symlink_metadata(&path)
                .map(|meta| !meta.file_type().is_symlink())
                .unwrap_or(false);
            let metadata = if exists {
                fs::metadata(&path).ok()
            } else {
                None
            };
            let size = metadata.as_ref().map(|meta| meta.len() as i64);
            let mtime = metadata
                .as_ref()
                .and_then(|meta| meta.modified().ok())
                .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64);

            update
                .execute(params![&node.id, exists, &size, &mtime, timestamp])
                .map_err(|error| format!("校验引用失败：{error}"))?;

            statuses.push(crate::models::RefStatus {
                node_id: node.id,
                path: Some(path),
                is_exists: exists,
                size,
                mtime,
            });
        }
    }

    transaction
        .commit()
        .map_err(|error| format!("提交校验失败：{error}"))?;
    // 校验会改写 is_exists：全量校验清空缩略图元信息缓存，否则按 id 失效对应条目。
    if let Ok(mut cache) = state.thumb_meta.lock() {
        if node_ids.is_empty() {
            cache.clear();
        } else {
            for node_id in node_ids {
                cache.remove(node_id);
            }
        }
    }
    Ok(statuses)
}

/// 重新关联：把节点指向用户新选的文件，保持原卡片位置与分组。
/// 命中去重索引时拒绝，避免一个文件出现两张卡片。
pub fn ref_relink(
    state: &AppState,
    node_id: &str,
    new_path: &str,
) -> Result<crate::models::RelinkResult, String> {
    let link_metadata = fs::symlink_metadata(new_path)
        .map_err(|error| format!("路径不可访问：{new_path}（{error}）"))?;
    if link_metadata.file_type().is_symlink() {
        return Err("不支持符号链接，请选择目标文件本身".to_string());
    }

    let canonical = fs::canonicalize(new_path)
        .map_err(|error| format!("路径不可访问：{new_path}（{error}）"))?;
    let metadata =
        fs::metadata(&canonical).map_err(|error| format!("读取文件信息失败：{error}"))?;
    let path = clean_path(&canonical);
    let dedupe_key = normalize_path_key(&canonical);
    let (kind, icon) = file_icon_and_kind(&canonical);
    let name = canonical
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    let subtitle = subtitle_for_path(&canonical);
    let ext = ext_of(Some(&path));
    let size = metadata.len() as i64;
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64);
    let timestamp = now_ms();

    let mut connection = state.db.lock().map_err(|error| error.to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开启事务失败：{error}"))?;

    let occupied: Option<(String, String)> = transaction
        .query_row(
            r#"
            SELECT n.id, n.name FROM nodes n
            JOIN refs r ON r.id = n.ref_id
            WHERE r.dedupe_key = ?1 AND r.kind IN ('file', 'folder') AND n.id <> ?2
            LIMIT 1
            "#,
            params![&dedupe_key, node_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("查询重复引用失败：{error}"))?;

    if let Some((existing_id, existing_name)) = occupied {
        return Err(format!(
            "该文件已在画布中：{existing_name}（节点 {existing_id}）"
        ));
    }

    let ref_kind = if kind == "folder" { "folder" } else { "file" };
    let search_text = format!("{name} {path} {subtitle}");
    transaction
        .execute(
            r#"
            UPDATE refs SET kind = ?2, dedupe_key = ?3, path = ?4, name = ?5, ext = ?6,
                            size = ?7, mtime = ?8, is_exists = 1, search_text = ?9, updated_at = ?10
            WHERE id = (SELECT ref_id FROM nodes WHERE id = ?1)
            "#,
            params![
                node_id,
                ref_kind,
                &dedupe_key,
                &path,
                &name,
                &ext,
                &size,
                &mtime,
                &search_text,
                timestamp
            ],
        )
        .map_err(|error| format!("更新引用失败：{error}"))?;
    transaction
        .execute(
            r#"
            UPDATE nodes SET type = ?2, icon = ?3, name = ?4, subtitle = ?5, updated_at = ?6
            WHERE id = ?1
            "#,
            params![node_id, kind, icon, &name, &subtitle, timestamp],
        )
        .map_err(|error| format!("更新节点失败：{error}"))?;

    let node = load_node_by_id(&transaction, node_id)
        .map_err(|error| format!("读取节点失败：{error}"))?
        .ok_or_else(|| "节点不存在".to_string())?;
    transaction
        .commit()
        .map_err(|error| format!("提交关联失败：{error}"))?;
    // 重关联换了路径：失效该节点的缩略图元信息缓存。
    if let Ok(mut cache) = state.thumb_meta.lock() {
        cache.remove(node_id);
    }

    Ok(crate::models::RelinkResult {
        node,
        status: crate::models::RefStatus {
            node_id: node_id.to_string(),
            path: Some(path),
            is_exists: true,
            size: Some(size),
            mtime,
        },
    })
}

// ---------- 缩略图 ----------

/// 按需生成并缓存缩略图，返回可直接用于 `<img src>` 的 data URL。
/// 只处理有磁盘路径且存在的引用；文字、链接、缺失文件返回 `None`，由前端回退系统图标。
/// 进程内缓存优先：命中后完全不锁数据库，只有每个节点的第一次请求才查一次读连接。
pub fn thumb_get(state: &AppState, node_id: &str, size: u32) -> Result<Option<String>, String> {
    let workspace = state.workspace_path()?;
    let cached = state
        .thumb_meta
        .lock()
        .map_err(|error| error.to_string())?
        .get(node_id)
        .cloned();
    let meta = match cached {
        Some(meta) => meta,
        None => {
            let record = {
                let connection = state.reader.lock().map_err(|error| error.to_string())?;
                connection
                    .query_row(
                        r#"
                        SELECT r.path, r.is_exists, r.thumb_key
                        FROM nodes n
                        LEFT JOIN refs r ON r.id = n.ref_id
                        WHERE n.id = ?1
                        "#,
                        params![node_id],
                        |row| {
                            Ok((
                                row.get::<_, Option<String>>(0)?,
                                row.get::<_, Option<bool>>(1)?,
                                row.get::<_, Option<String>>(2)?,
                            ))
                        },
                    )
                    .optional()
                    .map_err(|error| format!("读取缩略图信息失败：{error}"))?
                    .ok_or_else(|| "节点不存在".to_string())?
            };
            // 文字/链接（无 path）缓存为 None，之后不再查库。
            let value = record.0.map(|path| ThumbMeta {
                path,
                exists: record.1.unwrap_or(false),
                thumb_key: record.2,
            });
            state
                .thumb_meta
                .lock()
                .map_err(|error| error.to_string())?
                .insert(node_id.to_string(), value.clone());
            value
        }
    };
    let Some(meta) = meta else {
        return Ok(None);
    };
    if !meta.exists {
        return Ok(None);
    }

    let directory = workspace.join("thumbnails");
    let cache = directory.join(
        meta.thumb_key
            .clone()
            .unwrap_or_else(|| format!("{node_id}.png")),
    );

    let bytes = if cache.exists() {
        // 缓存文件命中：只读文件，不碰数据库。
        fs::read(&cache).map_err(|error| format!("读取缩略图缓存失败：{error}"))?
    } else {
        fs::create_dir_all(&directory).map_err(|error| format!("创建 thumbnails 失败：{error}"))?;
        let generated = crate::platform::shell_thumbnail(&meta.path, size)?;
        fs::write(&cache, &generated).map_err(|error| format!("写入缩略图缓存失败：{error}"))?;
        let key = cache
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("{node_id}.png"));
        {
            let connection = state.db.lock().map_err(|error| error.to_string())?;
            connection
                .execute(
                    "UPDATE refs SET thumb_key = ?2 WHERE id = (SELECT ref_id FROM nodes WHERE id = ?1)",
                    params![node_id, &key],
                )
                .map_err(|error| format!("保存缩略图键失败：{error}"))?;
        }
        if let Ok(mut map) = state.thumb_meta.lock() {
            if let Some(Some(entry)) = map.get_mut(node_id) {
                entry.thumb_key = Some(key);
            }
        }
        generated
    };

    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(Some(format!("data:image/png;base64,{encoded}")))
}

// ---------- 工作空间维护 ----------
/// 重建：清空所有业务数据，保留 `assets/` 与 `thumbnails/`（截图副本属于用户输入）。
/// 原文件永远不动；调用方必须先做二次确认。
pub fn workspace_rebuild(state: &AppState) -> Result<(), String> {
    let connection = state.db.lock().map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            r#"
            BEGIN;
            DELETE FROM annotation_targets;
            DELETE FROM annotations;
            DELETE FROM edges;
            DELETE FROM nodes;
            DELETE FROM groups;
            DELETE FROM refs;
            COMMIT;
            "#,
        )
        .map_err(|error| format!("重建工作空间失败：{error}"))?;
    connection
        .execute_batch("VACUUM")
        .map_err(|error| format!("压缩数据库失败：{error}"))?;
    // 节点已清空，缩略图元信息缓存一并失效。
    if let Ok(mut cache) = state.thumb_meta.lock() {
        cache.clear();
    }
    Ok(())
}

/// 递归复制目录；目标已存在时覆盖同名文件，不删除目标里的额外内容。
fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|error| format!("创建目录失败：{}（{error}）", to.display()))?;
    let entries = fs::read_dir(from).map_err(|error| format!("读取目录失败：{error}"))?;

    for entry in entries.flatten() {
        let source = entry.path();
        let target = to.join(entry.file_name());
        let metadata = entry
            .metadata()
            .map_err(|error| format!("读取文件信息失败：{error}"))?;
        if metadata.is_dir() {
            copy_dir(&source, &target)?;
        } else {
            fs::copy(&source, &target)
                .map_err(|error| format!("复制失败：{}（{error}）", source.display()))?;
        }
    }
    Ok(())
}

/// 迁移工作空间：复制 → 校验目标库可读 → 切换连接。
/// 任一步失败都保留旧目录与原连接，不做半成品切换。
pub fn workspace_migrate(state: &AppState, target: &Path) -> Result<WorkspaceInfo, String> {
    let current = state.workspace_path()?;
    if current == target {
        return Err("目标目录与当前工作空间相同".to_string());
    }
    if target.exists() {
        let empty = fs::read_dir(target)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if !empty {
            return Err("目标目录必须为空或不存在".to_string());
        }
    }

    {
        let connection = state.db.lock().map_err(|error| error.to_string())?;
        connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .map_err(|error| format!("刷新数据库失败：{error}"))?;
    }

    copy_dir(&current, target)?;

    let target_db = target.join("ploceus.db");
    let connection =
        Connection::open(&target_db).map_err(|error| format!("目标数据库不可用：{error}"))?;
    connection
        .execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")
        .map_err(|error| format!("目标数据库不可用：{error}"))?;
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM nodes", [], |row| row.get(0))
        .map_err(|error| format!("目标数据库校验失败：{error}"))?;
    drop(connection);

    let assets = target.join("assets");
    fs::create_dir_all(&assets).map_err(|error| format!("创建 assets 失败：{error}"))?;
    fs::create_dir_all(target.join("thumbnails"))
        .map_err(|error| format!("创建 thumbnails 失败：{error}"))?;

    {
        let mut guard = state.db.lock().map_err(|error| error.to_string())?;
        let new_connection =
            Connection::open(&target_db).map_err(|error| format!("打开目标数据库失败：{error}"))?;
        apply_pragmas(&new_connection).map_err(|error| format!("初始化目标数据库失败：{error}"))?;
        *guard = new_connection;
    }
    {
        let mut reader_guard = state.reader.lock().map_err(|error| error.to_string())?;
        let new_reader = Connection::open(&target_db)
            .map_err(|error| format!("打开目标只读连接失败：{error}"))?;
        apply_pragmas(&new_reader).map_err(|error| format!("初始化目标只读连接失败：{error}"))?;
        *reader_guard = new_reader;
    }
    // 缩略图元信息缓存指向旧工作空间，整体失效。
    if let Ok(mut cache) = state.thumb_meta.lock() {
        cache.clear();
    }
    *state.workspace.lock().map_err(|error| error.to_string())? = target.to_path_buf();
    *state.assets.lock().map_err(|error| error.to_string())? = assets;

    let _ = count;
    workspace_info(state)
}

// ---------- 基准数据种子 ----------

/// 生成 `count` 个不重叠的测试节点，按网格排布并带一个空间与若干连线。
/// 仅用于 1 万/10 万画布性能实测；用法：`PLOCEUS_BENCH_SEED=10000 pnpm tauri:dev`。
/// 节点为文字卡（`text`），不落任何真实文件引用，测完可直接「重建工作空间」清空。
pub fn seed_bench_nodes(state: &AppState, count: i64) -> Result<i64, String> {
    let mut connection = state.db.lock().map_err(|error| error.to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开启事务失败：{error}"))?;
    let timestamp = now_ms();

    // 12 列网格，与 1440px 视口下每屏可见量对齐；步长 80×72 对应图标格 + 间距。
    const COLUMNS: i64 = 12;
    let mut nodes = Vec::with_capacity(count as usize);
    for index in 0..count {
        let id = Uuid::new_v4().to_string();
        let col = index % COLUMNS;
        let row = index / COLUMNS;
        let x = col as f64 * 80.0;
        let y = row as f64 * 72.0;
        let name = format!("基准对象 {index}");
        transaction
            .execute(
                r#"
                INSERT INTO refs (id, kind, name, search_text, created_at, updated_at)
                VALUES (?1, 'link', ?2, ?2, ?3, ?3)
                "#,
                params![&id, &name, timestamp],
            )
            .map_err(|error| format!("写入引用失败：{error}"))?;
        transaction
            .execute(
                r#"
                INSERT INTO nodes
                    (id, type, icon, name, subtitle, body, ref_id, group_id, z,
                     parent_node_id, data_json, x, y, w, h, created_at, updated_at)
                VALUES (?1, 'text', 'text', ?2, '', ?2, ?1, '', 0, NULL, NULL, ?3, ?4, 72, 64, ?5, ?5)
                "#,
                params![&id, &name, x, y, timestamp],
            )
            .map_err(|error| format!("写入节点失败：{error}"))?;
        nodes.push(id);
    }

    // 一个覆盖首屏的空间 + 每 50 个节点一条连线，覆盖空间与连线在万级场景下的开销。
    let group_id = format!("group-bench-{}", Uuid::new_v4());
    transaction
        .execute(
            "INSERT INTO groups (id, title, x, y, w, h, created_at, updated_at) VALUES (?1, '基准空间', 0, 0, 400, 320, ?2, ?2)",
            params![&group_id, timestamp],
        )
        .map_err(|error| format!("写入空间失败：{error}"))?;
    for index in 0..count.min(400) {
        transaction
            .execute(
                "UPDATE nodes SET group_id = ?2 WHERE id = ?1",
                params![&nodes[index as usize], &group_id],
            )
            .map_err(|error| format!("写入空间成员失败：{error}"))?;
    }
    let mut edge_count = 0;
    let mut index = 0;
    while index + 1 < count.min(200) {
        transaction
            .execute(
                "INSERT INTO edges (id, from_node, to_node, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    format!("edge-bench-{}", Uuid::new_v4()),
                    &nodes[index as usize],
                    &nodes[(index + 1) as usize],
                    format!("基准连线 {edge_count}"),
                    timestamp
                ],
            )
            .map_err(|error| format!("写入连线失败：{error}"))?;
        edge_count += 1;
        index += 50;
    }

    transaction
        .commit()
        .map_err(|error| format!("提交基准数据失败：{error}"))?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MediaFixture {
        state: AppState,
        root: PathBuf,
    }

    impl MediaFixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("ploceus-media-test-{}", Uuid::new_v4()));
            fs::create_dir_all(root.join("assets")).expect("创建测试目录失败");
            let state = AppState {
                db: Mutex::new(Connection::open_in_memory().expect("打开测试库失败")),
                reader: Mutex::new(Connection::open_in_memory().expect("打开测试库失败")),
                workspace: Mutex::new(root.clone()),
                assets: Mutex::new(root.join("assets")),
                thumb_meta: Mutex::new(HashMap::new()),
            };
            Self { state, root }
        }
    }

    impl Drop for MediaFixture {
        fn drop(&mut self) {
            // 只清理本测试生成的 UUID 临时目录，不接触运行中的工作空间。
            fs::remove_dir_all(&self.root).expect("清理媒体测试目录失败");
        }
    }

    #[test]
    fn rich_media_roundtrip_preserves_binary_and_relative_reference() {
        let fixture = MediaFixture::new();
        for ext in RICH_MEDIA_EXTS {
            let mut body = vec![ext.len() as u8];
            body.extend_from_slice(ext.as_bytes());
            body.extend_from_slice(&[0, 255, 10, 128]);
            let relative = save_rich_asset(&fixture.state, &body).expect("上传失败");
            let name = relative
                .strip_prefix("assets/")
                .expect("引用必须为相对路径");
            let path = rich_asset_file(&fixture.state, name).expect("解析回读路径失败");
            assert_eq!(fs::read(path).expect("回读失败"), [0, 255, 10, 128]);
        }
    }

    #[test]
    fn rich_media_rejects_malformed_empty_and_oversized_uploads() {
        let fixture = MediaFixture::new();
        for body in [
            vec![],
            vec![8, b'p'],
            vec![1, 255],
            b"\x03exeX".to_vec(),
            b"\x03png".to_vec(),
        ] {
            assert!(save_rich_asset(&fixture.state, &body).is_err());
        }
        for (ext, limit) in [("png", 20), ("mp4", 100)] {
            let mut body = vec![0; 4 + limit * 1024 * 1024 + 1];
            body[..4].copy_from_slice(&[
                3,
                ext.as_bytes()[0],
                ext.as_bytes()[1],
                ext.as_bytes()[2],
            ]);
            assert!(save_rich_asset(&fixture.state, &body).is_err());
        }
        assert_eq!(
            fs::read_dir(fixture.root.join("assets"))
                .expect("读取测试目录失败")
                .count(),
            0
        );
    }

    #[test]
    fn rich_media_rejects_paths_and_external_asset_roots() {
        let fixture = MediaFixture::new();
        for name in [
            "",
            "../a.png",
            "sub/a.png",
            "sub\\a.png",
            "%2e.png",
            "a.png:stream.png",
            "a.exe",
        ] {
            assert!(
                rich_asset_file(&fixture.state, name).is_err(),
                "应拒绝：{name}"
            );
        }
        let outside = MediaFixture::new();
        *fixture.state.assets.lock().expect("锁定测试状态失败") = outside.root.join("assets");
        assert!(save_rich_asset(&fixture.state, b"\x03pngX").is_err());
        assert!(rich_asset_file(&fixture.state, "a.png").is_err());
    }

    #[test]
    fn migrate_creates_tables_and_sets_version() {
        let mut connection = Connection::open_in_memory().expect("打开内存库失败");
        migrate(&mut connection).expect("迁移失败");

        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("读取版本失败");
        assert_eq!(version, SCHEMA_VERSION);

        for table in [
            "refs",
            "nodes",
            "groups",
            "edges",
            "annotations",
            "app_meta",
        ] {
            let exists: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    params![table],
                    |row| row.get(0),
                )
                .expect("检查表失败");
            assert_eq!(exists, 1, "缺少表：{table}");
        }
    }

    #[test]
    fn migrate_normalizes_legacy_group_marker() {
        let mut connection = Connection::open_in_memory().expect("打开内存库失败");
        migrate(&mut connection).expect("初始迁移失败");
        connection
            .execute_batch(
                r#"
                INSERT INTO refs (id, kind, name, created_at, updated_at)
                VALUES ('n1', 'file', 'a.txt', 0, 0);
                INSERT INTO nodes (id, type, icon, name, group_id, x, y, w, h, created_at, updated_at, ref_id)
                VALUES ('n1', 'file', 'txt', 'a.txt', 'other', 0, 0, 72, 64, 0, 0, 'n1');
                "#,
            )
            .expect("插入旧数据失败");
        // 把版本拨回 0，模拟带旧数据的库再次走迁移流程。
        connection
            .execute_batch("PRAGMA user_version = 0")
            .expect("重置版本失败");
        migrate(&mut connection).expect("二次迁移失败");
        let group_id: String = connection
            .query_row("SELECT group_id FROM nodes WHERE id = 'n1'", [], |row| {
                row.get(0)
            })
            .expect("读取分组失败");
        assert_eq!(group_id, "");
    }
}
