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
    /// 所属分组框 ID；空字符串表示未分组。
    pub group_id: String,
    /// 叠放层级，数值大的在上层。
    pub z: i64,
    /// 相对父节点的挂载点；为空表示使用世界坐标。
    pub parent_node_id: Option<String>,
    /// 扩展样式（JSON 字符串），未使用时不写。
    pub data_json: Option<String>,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// 文件是否存在；`text` / `link` 恒为 true，由校验命令维护。
    pub is_exists: bool,
    /// 缩略图缓存键；为空表示尚未生成。
    pub thumb_key: Option<String>,
}

/// 分组框：独立存储，节点通过 `group_id` 归属，坐标始终为世界坐标。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneGroup {
    pub id: String,
    pub title: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 有向连线：`from` → `to` 为节点 ID；锚点为空时按节点中心自动路由。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub from_handle: Option<String>,
    pub to_handle: Option<String>,
    pub label: Option<String>,
    pub style_json: Option<String>,
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
    pub groups: Vec<SceneGroup>,
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

/// 工作空间信息，供设置面板展示；占用大小由文件系统统计。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub path: String,
    pub db_path: String,
    pub node_count: i64,
    pub size_bytes: u64,
    pub db_bytes: u64,
    pub assets_bytes: u64,
    pub thumbnail_bytes: u64,
}

/// 单个引用的磁盘校验结果；缺失与恢复都通过 `is_exists` 回传。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefStatus {
    pub node_id: String,
    pub path: Option<String>,
    pub is_exists: bool,
    pub size: Option<i64>,
    pub mtime: Option<i64>,
}

/// 重新关联结果：返回更新后的节点，前端直接替换卡片。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelinkResult {
    pub node: SceneNode,
    pub status: RefStatus,
}
