#!/usr/bin/env node
/**
 * 产物收集：把 NSIS 安装包从 cargo target 目录复制到项目根 release/。
 * 产物地址固定化，避免每次深入 desktop/target/release/bundle/nsis 找安装包。
 *
 * 用法：pnpm tauri:build（构建完成后自动执行），或手动 node scripts/collect-installer.mjs
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import console from 'node:console'
import process from 'node:process'

const nsisDir = join(process.cwd(), 'desktop', 'target', 'release', 'bundle', 'nsis')
const releaseDir = join(process.cwd(), 'release')

let installers
try {
  installers = readdirSync(nsisDir).filter((name) => name.endsWith('-setup.exe'))
} catch {
  console.error(`未找到产物目录：${nsisDir}\n请先执行 pnpm tauri:build 完成 NSIS 打包。`)
  process.exit(1)
}
if (installers.length === 0) {
  console.error(`产物目录为空：${nsisDir}\n请先执行 pnpm tauri:build 完成 NSIS 打包。`)
  process.exit(1)
}

mkdirSync(releaseDir, { recursive: true })
for (const name of installers) {
  copyFileSync(join(nsisDir, name), join(releaseDir, name))
  console.log(`产物已收集：release/${name}`)
}
