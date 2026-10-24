use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension, Row};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::models::{
    ImportError, ImportRequest, ImportResult, SceneAnnotation, SceneData, SceneEdge, SceneNode,
    WorkspaceInfo,
};
use crate::platform::{
    clean_path, file_icon_and_kind, normalize_path_key, now_ms, subtitle_for_path,
};

pub struct AppState {
    pub db: Mutex<Connection>,
    pub workspace: PathBuf,
    pub assets: PathBuf,
}

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
    CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        icon TEXT NOT NULL,
        name TEXT NOT NULL,
        subtitle TEXT NOT NULL DEFAULT '',
        body TEXT,
        ref_id TEXT UNIQUE,
        group_id TEXT NOT NULL DEFAULT 'other',
        x REAL NOT NULL,
        y REAL NOT NULL,
        w REAL NOT NULL,
        h REAL NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(ref_id) REFERENCES refs(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        from_node TEXT NOT NULL,
        to_node TEXT NOT NULL
    );
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
    "#
}

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

pub fn initialize(app: &AppHandle) -> Result<AppState, String> {
    let workspace = resolve_workspace(app)?;
    let assets = workspace.join("assets");
    fs::create_dir_all(&assets).map_err(|error| format!("创建 assets 失败：{error}"))?;
    fs::create_dir_all(workspace.join("thumbnails"))
        .map_err(|error| format!("创建 thumbnails 失败：{error}"))?;

    let db_path = workspace.join("ploceus.db");
    let connection =
        Connection::open(&db_path).map_err(|error| format!("打开 SQLite 失败：{error}"))?;
    connection
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")
        .map_err(|error| format!("初始化 SQLite 失败：{error}"))?;
    connection
        .execute_batch(schema())
        .map_err(|error| format!("建表失败：{error}"))?;

    Ok(AppState {
        db: Mutex::new(connection),
        workspace,
        assets,
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
        x: row.get(7)?,
        y: row.get(8)?,
        w: row.get(9)?,
        h: row.get(10)?,
        path: row.get(11)?,
        url: row.get(12)?,
    })
}

const NODE_SELECT: &str = r#"
    SELECT n.id, n.type, n.icon, n.name, n.subtitle, n.body, n.group_id,
           n.x, n.y, n.w, n.h, r.path, r.url
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

pub fn scene_load(state: &AppState) -> Result<SceneData, String> {
    let connection = state.db.lock().map_err(|error| error.to_string())?;

    let mut node_statement = connection
        .prepare(NODE_SELECT)
        .map_err(|error| format!("读取节点失败：{error}"))?;
    let nodes = node_statement
        .query_map([], row_to_node)
        .map_err(|error| format!("读取节点失败：{error}"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("读取节点失败：{error}"))?;
    drop(node_statement);

    let mut edge_statement = connection
        .prepare("SELECT id, from_node, to_node FROM edges")
        .map_err(|error| format!("读取连线失败：{error}"))?;
    let edges = edge_statement
        .query_map([], |row| {
            Ok(SceneEdge {
                id: row.get(0)?,
                from: row.get(1)?,
                to: row.get(2)?,
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

fn ext_of(path: Option<&String>) -> Option<String> {
    path.and_then(|value| Path::new(value).extension())
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
}

pub fn scene_save(state: &AppState, scene: &SceneData) -> Result<(), String> {
    let mut connection = state.db.lock().map_err(|error| error.to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开启事务失败：{error}"))?;

    transaction
        .execute_batch(
            "DELETE FROM annotation_targets; DELETE FROM annotations; DELETE FROM edges; DELETE FROM nodes; DELETE FROM refs;",
        )
        .map_err(|error| format!("清空场景失败：{error}"))?;

    let timestamp = now_ms();

    for node in &scene.nodes {
        let has_ref = node.path.is_some() || node.url.is_some();
        let ref_id = if has_ref { Some(node.id.clone()) } else { None };

        if let Some(ref id) = ref_id {
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

            transaction
                .execute(
                    r#"
                    INSERT INTO refs
                        (id, kind, dedupe_key, path, url, name, ext, size, mtime,
                         is_exists, thumb_key, search_text, created_at, updated_at)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, 1, NULL, ?8, ?9, ?9)
                    "#,
                    params![
                        &id,
                        kind,
                        &dedupe_key,
                        &path,
                        &url,
                        &node.name,
                        &ext,
                        &search_text,
                        timestamp
                    ],
                )
                .map_err(|error| format!("保存引用失败：{error}"))?;
        }

        transaction
            .execute(
                r#"
                INSERT INTO nodes
                    (id, type, icon, name, subtitle, body, ref_id, group_id,
                     x, y, w, h, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
                "#,
                params![
                    &node.id,
                    &node.kind,
                    &node.icon,
                    &node.name,
                    &node.subtitle,
                    &node.body,
                    &ref_id,
                    &node.group_id,
                    node.x,
                    node.y,
                    node.w,
                    node.h,
                    timestamp
                ],
            )
            .map_err(|error| format!("保存节点失败：{error}"))?;
    }

    for edge in &scene.edges {
        transaction
            .execute(
                "INSERT INTO edges (id, from_node, to_node) VALUES (?1, ?2, ?3)",
                params![&edge.id, &edge.from, &edge.to],
            )
            .map_err(|error| format!("保存连线失败：{error}"))?;
    }

    for annotation in &scene.annotations {
        transaction
            .execute(
                "INSERT INTO annotations (id, color, text, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
                params![&annotation.id, &annotation.color, &annotation.text, timestamp],
            )
            .map_err(|error| format!("保存标注失败：{error}"))?;
        for node_id in &annotation.node_ids {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO annotation_targets (annotation_id, node_id) VALUES (?1, ?2)",
                    params![&annotation.id, node_id],
                )
                .map_err(|error| format!("保存标注目标失败：{error}"))?;
        }
    }

    transaction
        .commit()
        .map_err(|error| format!("提交场景失败：{error}"))?;
    Ok(())
}

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

        if let Some(node) = existing_node {
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
        let x = request.x + (index % 6) as f64 * 184.0;
        let y = request.y + (index / 6) as f64 * 32.0;
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
            group_id: "other".to_string(),
            x,
            y,
            w: 176.0,
            h: 28.0,
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

pub fn workspace_info(state: &AppState) -> Result<WorkspaceInfo, String> {
    let connection = state.db.lock().map_err(|error| error.to_string())?;
    let node_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM nodes", [], |row| row.get(0))
        .unwrap_or(0);

    Ok(WorkspaceInfo {
        path: state.workspace.to_string_lossy().to_string(),
        db_path: state
            .workspace
            .join("ploceus.db")
            .to_string_lossy()
            .to_string(),
        node_count,
    })
}

pub fn node_target(
    state: &AppState,
    node_id: &str,
) -> Result<(Option<String>, Option<String>), String> {
    let connection = state.db.lock().map_err(|error| error.to_string())?;
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

pub fn save_asset(state: &AppState, bytes: &[u8], ext: &str) -> Result<String, String> {
    fs::create_dir_all(&state.assets).map_err(|error| format!("创建 assets 失败：{error}"))?;
    let path = state.assets.join(format!("{}.{}", Uuid::new_v4(), ext));
    fs::write(&path, bytes).map_err(|error| format!("写入截图失败：{error}"))?;
    Ok(path.to_string_lossy().to_string())
}

pub fn node_by_id(state: &AppState, node_id: &str) -> Result<Option<SceneNode>, String> {
    let connection = state.db.lock().map_err(|error| error.to_string())?;
    load_node_by_id(&connection, node_id).map_err(|error| format!("读取节点失败：{error}"))
}
