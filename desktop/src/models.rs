//! IPC 数据传输对象：字段与前端 `client/types/scene.ts` 一一对应。
//! 所有坐标使用画布世界坐标（px）；文件内容与元数据不出本机。

use serde::{Deserialize, Serialize};

/// 画布节点。`path` / `url` 只保存引用，不保存文件内容。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneNode {
    pub id: String,
    /// `file` / `folder` / `image` / `video` / `text` / `link`
    pub kind: String,
    /// 展示用系统图标种类，不参与业务判断。
    pub icon: String,
    pub name: String,
    pub path: Option<String>,
    pub subtitle: String,
    pub body: Option<String>,
    pub url: Option<String>,
    pub group_id: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 有向连线：`from` → `to` 为节点 ID。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneEdge {
    pub id: String,
    pub from: String,
    pub to: String,
}

/// 结构化标注，可覆盖多个节点。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneAnnotation {
    pub id: String,
    pub node_ids: Vec<String>,
    pub color: String,
    pub text: String,
}

/// `scene_load` / `scene_save` 的完整场景快照。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SceneData {
    pub nodes: Vec<SceneNode>,
    pub edges: Vec<SceneEdge>,
    pub annotations: Vec<SceneAnnotation>,
}

/// 批量导入请求：`paths` 为绝对路径，`x` / `y` 为落点中心。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub paths: Vec<String>,
    pub x: f64,
    pub y: f64,
}

/// 单个导入失败项；`reason` 必须可让用户定位原因（HC-14）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportError {
    pub path: String,
    pub reason: String,
}

/// 批量导入结果：新建、命中去重、失败三部分都返回，不允许静默丢弃。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportResult {
    pub created: Vec<SceneNode>,
    pub existing: Vec<SceneNode>,
    pub errors: Vec<ImportError>,
}

/// 工作空间信息，供设置面板展示。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub path: String,
    pub db_path: String,
    pub node_count: i64,
}
