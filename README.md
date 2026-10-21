# 络雀（ploceusTidy）

<p align="center">
  <img src="assets/ploceusTidy.png" alt="络雀：正在织巢的织雀" width="360">
</p>

方便快捷的个人文件整理客户端：扫描指定目录，按规则生成整理方案，预演确认后执行，并支持按操作记录撤销。

名字取自织雀筑巢——把散落的材料编织成有序的巢，正如把散乱文件归位。

> 当前处于立项阶段：已完成规范文档，技术选型与源码尚未落地。

## 当前状态

| 项 | 状态 |
| --- | --- |
| 规范文档 | 已建立（入口：[docs/README.md](docs/README.md)） |
| 技术选型 | 待定，见 [08-adr.md](docs/spec/08-adr.md) 待决清单 |
| 源码 | 未开始 |
| 开发命令 | 选型确定后补齐 |

## 开发前必读

1. [AGENTS.md](AGENTS.md) —— AI 协作入口与硬边界
2. [docs/README.md](docs/README.md) —— 硬约束清单与工作流
3. [docs/project-overview.md](docs/project-overview.md) —— 文件级地图

## 范围

v1 目标：目录扫描 → 规则分类 → 方案预演 → 确认执行 → 操作记录 → 撤销。详见 [00-overview.md](docs/spec/00-overview.md)。
