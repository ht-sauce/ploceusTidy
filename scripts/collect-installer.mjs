#!/usr/bin/env node
/**
 * 产物收集：把 NSIS 安装包从 cargo target 目录复制到项目根 release/。
 * 产物地址固定化，避免每次深入 desktop/target/release/bundle/nsis 找安装包。
 *
 * 只收集**当前版本**（读 desktop/tauri.conf.json 的 version）：
 * bundle 目录会累积历史版本，全量复制会让 release/ 又长出一堆旧安装包。
 *
 * 用法：pnpm tauri:build（构建完成后自动执行），或手动 node scripts/collect-installer.mjs
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import console from 'node:console'
import process from 'node:process'

const root = process.cwd()
const nsisDir = join(root, 'desktop', 'target', 'release', 'bundle', 'nsis')
const releaseDir = join(root, 'release')

const version = JSON.parse(readFileSync(join(root, 'desktop', 'tauri.conf.json'), 'utf8')).version

let installers
try {
  installers = readdirSync(nsisDir).filter((name) => name.endsWith('-setup.exe'))
} catch {
  console.error(`未找到产物目录：${nsisDir}\n请先执行 pnpm tauri:build 完成 NSIS 打包。`)
  process.exit(1)
}

const current = installers.filter((name) => name.includes(`_${version}_`))
if (current.length === 0) {
  console.error(
    `产物目录里没有 v${version} 的安装包：${nsisDir}\n现有产物：${installers.join(', ') || '(空)'}`,
  )
  process.exit(1)
}

mkdirSync(releaseDir, { recursive: true })
for (const name of current) {
  copyFileSync(join(nsisDir, name), join(releaseDir, name))
  console.log(`产物已收集：release/${name}`)
}
const stale = installers.filter((name) => !current.includes(name))
if (stale.length > 0) {
  console.log(`已跳过 ${stale.length} 个历史版本产物（仅保留 v${version}）：${stale.join(', ')}`)
}
