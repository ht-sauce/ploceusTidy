﻿# 07-packaging.md · 打包与运行

## 1. 目标

- Windows 10/11 x64 首发；Tauri 2 + WebView2。
- 安装包轻量、启动快；默认按用户安装，避免管理员权限。
- 主窗口 `decorations: false` 无边框；48px 自定义标题栏：logo、居中搜索、窗口控制按钮与拖拽区。
- 数据与安装目录策略见 `04-data-model.md`。

## 2. 安装形态

- 默认 NSIS 按用户安装（`%LOCALAPPDATA%\Programs\ploceusTidy`）。
- 安装包语言：`bundle.windows.nsis.languages` 配置 `SimpChinese` + `English`，默认跟随系统语言、命中不到时用第一条；`displayLanguageSelector: true` 先弹语言选择框，中英文用户都能读懂安装流程。
- WebView2 使用 bootstrapper 下载模式，减小安装包；企业/离线环境可提供离线安装包。
- 安装目录可写时，`dataWorkSpace` 默认在其下；否则回退 Tauri `app_data_dir\dataWorkSpace`（Windows 通常为 `%APPDATA%\com.ploceus.tidy\dataWorkSpace`）。
- 安装/升级不得覆盖或删除 `dataWorkSpace`；卸载默认保留，由用户手动清理；安装包需明确提示。

## 3. 数据位置

- 启动时解析：用户设置 > 安装目录 `dataWorkSpace`（可写）> 用户本地回退目录。
- 设置中显示实际路径与占用；迁移走复制 → 校验 → 切换，失败保留旧目录。
- 迁移期间**持有写锁**：拷贝到切换之间任何一次防抖保存都会写进即将丢弃的旧库，切换后前端基线仍以为「已保存」，那笔改动就永久丢了。读走独立连接（WAL 快照），界面与缩略图不受影响，只有写命令排队等拷贝结束。新连接与路径在切换前全部准备好并校验，最后一次性替换，不出现「写新库、读旧库」的半切换。
- 不在 `Program Files` 下强写；无写权限时自动回退，不弹错误弹窗阻断启动。

## 4. 构建与发布

- **版本号**：每一次需求更新与 bug 修复都提升版本号（`HC-17`）。修 bug / 小改动走 patch，成批新能力走 minor；用 `pnpm version:bump patch|minor|major|<x.y.z>` 一次同步 `package.json`、`desktop/tauri.conf.json`、`desktop/Cargo.toml`、`desktop/Cargo.lock` 四处副本，禁止手工只改一处。`pnpm check-spec` 校验四处一致，并要求 `release/log.md` 存在 `## v<当前版本>` 段落且至少有一条改动说明。
- 构建命令：前端 `pnpm build`，桌面安装包 `pnpm tauri:build`；仅导出 exe 可用 `pnpm tauri build --no-bundle`。
- 安装包原始产物在 `desktop/target/release/bundle/nsis/`；`pnpm tauri:build` 完成后由 `scripts/collect-installer.mjs` 自动复制到项目根 `release/`（入库，README 直接链接最新安装包供下载），发布取包一律用 `release/` 下的最新安装包。收集脚本只取 `desktop/tauri.conf.json` 里当前版本的产物，bundle 目录里积累的历史版本不会被重新复制进来；`release/` 只保留最新一个安装包。
- 自动更新（v0.3.0 起启用，见 `08-adr.md` ADR-038）：`tauri-plugin-updater` + GitHub Releases 的 `latest.json`；更新包用 minisign 私钥签名、客户端内置公钥验签；`bundle.createUpdaterArtifacts` 打开后**每次打包都必须提供 `TAURI_SIGNING_PRIVATE_KEY`**，统一由 `pnpm tauri:build`（`scripts/tauri-build.mjs`）注入 `desktop/signing/updater.key`。私钥与密码不入库，必须离线备份——丢失后已安装的客户端只能手动重装一次。
- 发布三件套（`pnpm release:publish`，`scripts/publish-release.mjs`）：安装包（`*_x64-setup.exe`，手动下载与自动更新共用同一个文件）、更新签名 `*.exe.sig`（Tauri 2 的 NSIS 更新产物就是安装包本体的签名，不再额外打包 zip），加脚本生成的 `latest.json`；资产名一律 ASCII（GitHub 丢弃中文，且 `latest.json` 的 url 必须与资产名一致）。`--dry-run` 只生成暂存产物与上传清单，不联网。
- 安装钩子 `desktop/installer-hooks.nsh`（`bundle.windows.nsis.installerHooks`）：安装时在「发送到」菜单写入 `络雀.lnk`，卸载时删除。配合启动参数「存在即导入」，右键文件即可丢进画布；应用已在运行时由单实例转发路径。
- 全局热键 `Ctrl+Alt+Space` 由 `tauri-plugin-global-shortcut` 在 Rust 侧注册（不经过前端 ACL），被占用时只记日志、不阻止启动。
- 单实例：`tauri-plugin-single-instance` 保证同时只有一个进程与窗口；重复启动把已有窗口恢复并聚焦，避免两个窗口写同一份 `dataWorkSpace`（ADR-024）。产品不做多画布。
- 代码签名：使用本机自签名代码签名证书（`CN=ploceusTidy`，SHA256，有效期 5 年），由 Tauri 按 `desktop/tauri.windows.conf.json` 的 `certificateThumbprint` 自动调用 signtool 签名主程序、卸载器与安装包（该配置换机不同，不入库）。pfx 备份与密码在 `desktop/signing/`（不入库）。自签名证书不受系统信任，SmartScreen 提示依旧；正式 CA 证书待有真实分发需求时评估（见 `08-adr.md` §5）。
- 发布渠道：GitHub Releases（`v0.1.0` 起，当前 `v0.1.4`），安装包资产名用 ASCII 形式 `ploceusTidy_<版本>_x64-setup.exe`——GitHub 会丢弃资产名中的中文字符；本地 `release/` 目录保留中文原名安装包，且只保留最新一个版本。
- 不接入崩溃上报/遥测。

## 5. 体积与启动

- 目标：安装包显著小于 Electron 同类应用；冷启动不加载 Chromium/Node 运行时。
- 不打包离线 WebView2（除非发布离线版）。
- 首屏只加载紧凑场景索引，不加载全部缩略图与图片。
