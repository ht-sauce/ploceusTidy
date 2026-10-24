# 07-packaging.md · 打包与运行

## 1. 目标

- Windows 10/11 x64 首发；Tauri 2 + WebView2。
- 安装包轻量、启动快；默认按用户安装，避免管理员权限。
- 主窗口 `decorations: false` 无边框；自定义 48px 标题栏、项目 logo、窗口控制按钮与拖拽区。
- 数据与安装目录策略见 `04-data-model.md`。

## 2. 安装形态

- 默认 NSIS 按用户安装（`%LOCALAPPDATA%\Programs\ploceusTidy`）。
- WebView2 使用 bootstrapper 下载模式，减小安装包；企业/离线环境可提供离线安装包。
- 安装目录可写时，`dataWorkSpace` 默认在其下；否则回退 `%LOCALAPPDATA%\ploceusTidy\dataWorkSpace`。
- 安装/升级不得覆盖或删除 `dataWorkSpace`；卸载默认保留，由用户手动清理；安装包需明确提示。

## 3. 数据位置

- 启动时解析：用户设置 > 安装目录 `dataWorkSpace`（可写）> 用户本地回退目录。
- 设置中显示实际路径与占用；迁移走复制 → 校验 → 切换，失败保留旧目录。
- 不在 `Program Files` 下强写；无写权限时自动回退，不弹错误弹窗阻断启动。

## 4. 构建与发布

- 前端构建命令已落地：`pnpm build`；Tauri 打包命令在后端脚手架建立后同批补入 `AGENTS.md` 与根 `README.md`。
- 不启用自动更新（v1）；手动安装包升级，保留 `dataWorkSpace`。
- 代码签名与 SmartScreen 处理后续补充；v1 先保证本地可安装运行。
- 不接入崩溃上报/遥测；日志只写本地。

## 5. 体积与启动

- 目标：安装包显著小于 Electron 同类应用；冷启动不加载 Chromium/Node 运行时。
- 不打包离线 WebView2（除非发布离线版）。
- 首屏只加载紧凑场景索引，不加载全部缩略图与图片。
