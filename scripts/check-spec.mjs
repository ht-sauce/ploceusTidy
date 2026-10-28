#!/usr/bin/env node
/**
 * 规范扫描：把可静态化的硬约束变成脚本检查。
 * 只检查「违反会导致功能异常/数据事故」的规则，风格问题交给 eslint 与 prettier。
 *
 * 用法：pnpm check-spec
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import console from 'node:console'
import process from 'node:process'

const root = process.cwd()
const failures = []

/** 递归收集指定目录下的目标文件。 */
function collectFiles(dir, extensions) {
  const result = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'target') continue
      result.push(...collectFiles(full, extensions))
    } else if (extensions.some((ext) => entry.endsWith(ext))) {
      result.push(full)
    }
  }
  return result
}

function report(file, line, rule, message) {
  failures.push(`${relative(root, file)}:${line} [${rule}] ${message}`)
}

function scanFile(file, rules) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, index) => {
    for (const rule of rules) {
      if (rule.pattern.test(line)) report(file, index + 1, rule.name, rule.message)
    }
  })
}

// ---------- HC-15：禁止自增 ID 作为关联键 ----------
const rustRules = [
  {
    name: 'HC-15',
    pattern: /INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/i,
    message: '禁止自增主键，关联键一律用 UUID（HC-15）',
  },
]

// ---------- HC-16：长命令死等属于工作流约束，此处不扫描 ----------

// ---------- HC-13：数据不出本机（只扫网络请求入口，展示用 URL 字符串不算） ----------
const tsRules = [
  {
    name: 'HC-13',
    pattern: /fetch\(\s*['"`]https?:\/\/(?!127\.0\.0\.1|localhost)/i,
    message: '前端发起外部网络请求，数据可能出本机（HC-13）',
  },
  {
    name: 'HC-13',
    pattern: /XMLHttpRequest|navigator\.sendBeacon|WebSocket\(\s*['"`]wss?:\/\//i,
    message: '前端存在外部网络通信入口，确认是否违反纯本地约束（HC-13）',
  },
]

// ---------- HC-4：不主动创建新文档 ----------
const docFiles = readdirSync(root).filter((name) => name.endsWith('.md') && name !== 'AGENTS.md')
if (docFiles.length > 1) {
  report(root, 1, 'HC-4', `仓库根目录多余 Markdown：${docFiles.join(', ')}`)
}

// ---------- HC-17：版本号四处一致 + 发布日志有当前版本条目 ----------
// 「每次需求改动与 bug 修复都要变版本号」无法静态判定有没有改，
// 但能判定两件必然后果：版本号副本不同步、改了版本却没写发布日志。
function checkVersion() {
  const read = (path) => readFileSync(join(root, path), 'utf8')
  const four = [
    ['package.json', read('package.json').match(/"version":\s*"([^"]+)"/)?.[1]],
    [
      'desktop/tauri.conf.json',
      read('desktop/tauri.conf.json').match(/"version":\s*"([^"]+)"/)?.[1],
    ],
  ]
  const cargo = read('desktop/Cargo.toml')
  const packageIndex = cargo.indexOf('[package]')
  four.push(['desktop/Cargo.toml', cargo.slice(packageIndex).match(/^version = "([^"]+)"/m)?.[1]])
  const lock = read('desktop/Cargo.lock')
  four.push([
    'desktop/Cargo.lock',
    lock.match(/name = "ploceus-desktop"\r?\nversion = "([^"]+)"/)?.[1],
  ])

  const versions = four.map(([, value]) => value)
  if (versions.some((value) => !value)) {
    const missing = four.filter(([, value]) => !value).map(([name]) => name)
    report(root, 1, 'HC-17', `读不到版本号：${missing.join(', ')}`)
    return null
  }
  const distinct = [...new Set(versions)]
  if (distinct.length > 1) {
    const detail = four.map(([name, value]) => `${name}=${value}`).join('，')
    report(
      join(root, 'package.json'),
      1,
      'HC-17',
      `版本号不一致：${detail}；用 pnpm version:bump 同步（HC-17）`,
    )
    return null
  }

  // 发布日志：当前版本必须有独立段落，且至少写了一条改动说明。
  const version = distinct[0]
  const log = read('release/log.md')
  const heading = `## v${version}`
  const start = log.indexOf(heading)
  if (start < 0) {
    report(
      join(root, 'release', 'log.md'),
      1,
      'HC-17',
      `缺少「${heading}」条目：改了版本就要写发布日志（HC-17）`,
    )
    return version
  }
  const rest = log.slice(start + heading.length)
  const end = rest.search(/^## v/m)
  const section = end < 0 ? rest : rest.slice(0, end)
  const bullets = section.split(/\r?\n/).filter((line) => /^-\s+\S{4,}/.test(line.trim()))
  if (bullets.length === 0) {
    report(join(root, 'release', 'log.md'), 1, 'HC-17', `「${heading}」没有任何改动条目（HC-17）`)
  }
  return version
}

const version = checkVersion()

// ---------- 源码扫描 ----------
for (const file of collectFiles(join(root, 'desktop', 'src'), ['.rs'])) {
  scanFile(file, rustRules)
}
for (const file of collectFiles(join(root, 'client'), ['.ts', '.tsx'])) {
  scanFile(file, tsRules)
}

if (failures.length > 0) {
  console.error(`check-spec：${failures.length} 项不合规`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log(`check-spec：通过（当前版本 v${version ?? '未知'}）`)
