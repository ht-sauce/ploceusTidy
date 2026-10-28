#!/usr/bin/env node
/**
 * 版本号提升：把一次需求改动或 bug 修复对应的版本号在四处一次改完。
 *
 * 版本号有四个副本（前端、Tauri 配置、Cargo 清单、Cargo 锁），
 * 手工改必然漏一处，漏掉的那处会让安装包版本与界面显示不一致。
 *
 * 用法：
 *   pnpm version:bump patch         # 0.1.3 → 0.1.4（修 bug / 小改动）
 *   pnpm version:bump minor         # 0.1.3 → 0.2.0（成批新能力）
 *   pnpm version:bump 0.1.4         # 指定版本
 *
 * 策略：先把四个文件全读出来校验一致，再一次性落盘——任何一处不一致都直接报错，
 * 不会出现「改了两个文件才发现第三个不对」的半途状态。
 *
 * 只改版本号，不写发布日志：`release/log.md` 的条目要人写，
 * `pnpm check-spec` 会检查当前版本有没有对应段落，漏写直接报错（HC-17）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import console from 'node:console'
import process from 'node:process'

const root = process.cwd()
const SEMVER = /^\d+\.\d+\.\d+$/

const targets = [
  {
    label: 'package.json',
    path: join(root, 'package.json'),
    pattern: /("version":\s*")([^"]+)(")/,
  },
  {
    label: 'desktop/tauri.conf.json',
    path: join(root, 'desktop', 'tauri.conf.json'),
    pattern: /("version":\s*")([^"]+)(")/,
  },
  {
    // 只认 [package] 段里的第一处，依赖的 version 不能动。
    label: 'desktop/Cargo.toml',
    path: join(root, 'desktop', 'Cargo.toml'),
    pattern: /(^version = ")([^"]+)(")/m,
    from: '[package]',
  },
  {
    // 只认本包条目，其它 crate 的 version 不能动。
    label: 'desktop/Cargo.lock',
    path: join(root, 'desktop', 'Cargo.lock'),
    pattern: /(name = "ploceus-desktop"\r?\nversion = ")([^"]+)(")/,
  },
]

/** 读取文件并按规则取出当前版本号；`from` 指定从哪个锚点之后开始匹配。 */
function inspect(target) {
  const text = readFileSync(target.path, 'utf8')
  const offset = target.from ? text.indexOf(target.from) : 0
  if (offset < 0) throw new Error(`${target.label} 缺少 ${target.from} 段`)
  const match = text.slice(offset).match(target.pattern)
  if (!match) throw new Error(`无法从 ${target.label} 读取版本号`)
  return { ...target, text, offset, version: match[2] }
}

const files = targets.map(inspect)
const current = files[0].version
if (!SEMVER.test(current)) throw new Error(`package.json 的版本号不是 x.y.z：${current}`)

const drifted = files.filter((file) => file.version !== current)
if (drifted.length > 0) {
  const detail = files.map((file) => `${file.label}=${file.version}`).join('，')
  throw new Error(`版本号副本已不一致（${detail}），先手工对齐再 bump`)
}

const argument = process.argv[2]
if (!argument) {
  console.error('用法：pnpm version:bump patch|minor|major|<x.y.z>')
  process.exit(1)
}

function nextVersion(from, mode) {
  if (SEMVER.test(mode)) return mode
  const [major, minor, patch] = from.split('.').map(Number)
  if (mode === 'major') return `${major + 1}.0.0`
  if (mode === 'minor') return `${major}.${minor + 1}.0`
  if (mode === 'patch') return `${major}.${minor}.${patch + 1}`
  throw new Error(`无法识别的版本参数：${mode}（只接受 patch / minor / major / x.y.z）`)
}

const next = nextVersion(current, argument)
if (next === current) throw new Error(`版本号未变化：${current}`)

// 先算好四份新内容，全部成功后再落盘，避免半途失败留下不一致的副本。
for (const file of files) {
  const slice = file.text.slice(file.offset)
  const updated = slice.replace(file.pattern, `$1${next}$3`)
  if (updated === slice) throw new Error(`${file.label} 未匹配到版本号，未写入任何文件`)
  file.nextText = file.text.slice(0, file.offset) + updated
}

for (const file of files) writeFileSync(file.path, file.nextText)

console.log(`版本号：${current} → ${next}`)
console.log(`已同步：${files.map((file) => file.label).join(' / ')}`)
console.log(`下一步：补写 release/log.md 的「## v${next}（YYYY-MM-DD）」条目，再跑 pnpm check-spec`)
