# 07-packaging.md · 打包与运行

## 1. 目标

- Windows 10/11 x64 首发；Tauri 2 + WebView2。
- 安装包轻量、启动快；默认按用户安装，避免管理员权限。
- 主窗口 `decorations: false` 无边框；48px 自定义标题栏：logo、居中搜索、窗口控制按钮与拖拽区。
- 数据与安装目录策略见 `04-data-model.md`。

## 2. 安装形态

- 默认 NSIS 按用户安装（`%LOCALAPPDATA%\Programs\ploceusTidy`）。
- WebView2 使用 bootstrapper 下载模式，减小安装包；企业/离线环境可提供离线安装包。
- 安装目录可写时，`dataWorkSpace` 默认在其下；否则回退 Tauri `app_data_dir\dataWorkSpace`（Windows 通常为 `%APPDATA%\com.ploceus.tidy\dataWorkSpace`）。
- 安装/升级不得覆盖或删除 `dataWorkSpace`；卸载默认保留，由用户手动清理；安装包需明确提示。

## 3. 数据位置

- 启动时解析：用户设置 > 安装目录 `dataWorkSpace`（可写）> 用户本地回退目录。
- 设置中显示实际路径与占用；迁移走复制 → 校验 → 切换，失败保留旧目录。
- 不在 `Program Files` 下强写；无写权限时自动回退，不弹错误弹窗阻断启动。

## 4. 构建与发布

- 构建命令：前端 `pnpm build`，桌面安装包 `pnpm tauri:build`；仅导出 exe 可用 `pnpm tauri build --no-bundle`。
- 安装包原始产物在 `desktop/target/release/bundle/nsis/`；`pnpm tauri:build` 完成后由 `scripts/collect-installer.mjs` 自动复制到项目根 `release/`（不入库），发布取包一律用 `release/` 下的最新安装包。
- 不启用自动更新（v1）；手动安装包升级，保留 `dataWorkSpace`。
- 代码签名：使用本机自签名代码签名证书（`CN=ploceusTidy`，SHA256，有效期 5 年），由 Tauri 按 `desktop/tauri.windows.conf.json` 的 `certificateThumbprint` 自动调用 signtool 签名主程序、卸载器与安装包（该配置换机不同，不入库）。pfx 备份与密码在 `desktop/signing/`（不入库）。自签名证书不受系统信任，SmartScreen 提示依旧；正式 CA 证书待有真实分发需求时评估（见 `08-adr.md` §5）。
- 发布渠道：GitHub Releases（`v0.1.0` 起），安装包资产名用 ASCII 形式 `ploceusTidy_<版本>_x64-setup.exe`——GitHub 会丢弃资产名中的中文字符；本地 `release/` 目录保留中文原名安装包。
- 不接入崩溃上报/遥测。

## 5. 体积与启动

- 目标：安装包显著小于 Electron 同类应用；冷启动不加载 Chromium/Node 运行时。
- 不打包离线 WebView2（除非发布离线版）。
- 首屏只加载紧凑场景索引，不加载全部缩略图与图片。
