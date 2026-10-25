/**
 * 场景序列化 Worker：把 JSON.stringify 移出主线程。
 * 10 万对象的全量序列化在主线程约 100–300ms，会表现为松手保存后的一次性卡顿；
 * 主线程只做一次结构化克隆（比 stringify 便宜），字符串回传后直接交给 Tauri invoke。
 */
self.onmessage = (event: MessageEvent<{ scene: unknown }>) => {
  self.postMessage(JSON.stringify(event.data.scene))
}
