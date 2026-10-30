#!/usr/bin/env node
/**
 * 发布：把当前版本安装包、更新签名与 latest.json 传到 GitHub Releases。
 *
 * 自动更新读的是 `releases/latest/download/latest.json`，所以每次发版三件套缺一不可：
 * 安装包（既是手动下载的包，也是自动更新下载的包）、`*.exe.sig`（Tauri 2 的 NSIS
 * 更新产物就是安装包本体的签名）、`latest.json`（指明版本、签名与下载地址）。
 * 资产名必须是 ASCII：GitHub 会丢弃中文，而 latest.json 里的 url 必须与实际资产名一致。
 *
 * 用法：
 *   pnpm release:publish            生成产物并调用 gh 上传
 *   pnpm release:publish --dry-run  只生成 latest.json 与上传清单，不联网
 */
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import console from 'node:console'
import process from 'node:process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')

const version = JSON.parse(readFileSync(join(root, 'desktop', 'tauri.conf.json'), 'utf8')).version
const tag = `v${version}`
const bundleDir = join(root, 'desktop', 'target', 'release', 'bundle', 'nsis')
const releaseDir = join(root, 'release')
const stageDir = join(root, 'desktop', 'target', 'publish', tag)

/** 从 origin 解析 owner/repo；读不到就用发布配置里的固定值。 */
function resolveRepo() {
  const fromEnv = process.env.PLOCEUS_RELEASE_REPO
  if (fromEnv) return fromEnv
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' })
  const match = /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?/.exec(remote.stdout ?? '')
  if (match) return `${match[1]}/${match[2]}`
  return 'ht-sauce/ploceusTidy'
}

/** 抽取 release/log.md 里当前版本的段落作为发布说明。 */
function readNotes() {
  const log = readFileSync(join(releaseDir, 'log.md'), 'utf8')
  const start = log.indexOf(`## ${tag}`)
  if (start === -1) {
    console.error(`release/log.md 里没有 ${tag} 段落：请先补发布日志（HC-17）`)
    process.exit(1)
  }
  const rest = log.slice(start)
  const next = rest.indexOf('\n## v', 4)
  const section = next === -1 ? rest : rest.slice(0, next)
  // 「### 下载」之后是手动下载说明，放进 Release 正文里会与附件重复。
  const downloadAt = section.indexOf('### 下载')
  const body = downloadAt === -1 ? section : section.slice(0, downloadAt)
  // Release 标题已经是版本号了，正文里不再重复一级标题。
  return body
    .split('\n')
    .filter((line, index) => !(index === 0 && line.startsWith('## ')))
    .join('\n')
    .trim()
}

function findArtifacts() {
  if (!existsSync(bundleDir)) {
    console.error(`未找到产物目录：${bundleDir}\n请先执行 pnpm tauri:build。`)
    process.exit(1)
  }
  const names = readdirSync(bundleDir)
  const exe = names.find((name) => name.includes(`_${version}_`) && name.endsWith('-setup.exe'))
  if (!exe) {
    console.error(
      `缺少 v${version} 的安装包：${bundleDir}\n请确认打包时已注入签名私钥（pnpm tauri:build）。`,
    )
    process.exit(1)
  }
  // Tauri 2 的 NSIS 更新产物就是安装包本身 + 同名 `.sig`（不再打包成 .nsis.zip）。
  const sig = `${exe}.sig`
  if (!names.includes(sig)) {
    console.error(
      `缺少更新签名：${sig}\n请确认 bundle.createUpdaterArtifacts 已开启且构建时注入了私钥。`,
    )
    process.exit(1)
  }
  return { exe, sig }
}

const repo = resolveRepo()
const { exe, sig } = findArtifacts()
const notes = readNotes()

// ASCII 资产名：与 release/log.md 里的中文名安装包并存，但上传用这一份。
const asciiBase = `ploceusTidy_${version}_x64-setup`
const asciiExe = `${asciiBase}.exe`
const asciiSig = `${asciiExe}.sig`

mkdirSync(stageDir, { recursive: true })
copyFileSync(join(bundleDir, exe), join(stageDir, asciiExe))
copyFileSync(join(bundleDir, sig), join(stageDir, asciiSig))

const signature = readFileSync(join(stageDir, asciiSig), 'utf8').trim()
const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature,
      url: `https://github.com/${repo}/releases/download/${tag}/${asciiExe}`,
    },
  },
}
writeFileSync(join(stageDir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`)

console.log(`仓库：${repo}    版本：${version}`)
console.log(`暂存目录：${stageDir}`)
console.log(`- ${asciiExe}（安装包 + 自动更新下载的包）`)
console.log(`- ${asciiSig}`)
console.log('- latest.json')

if (dryRun) {
  console.log('\n--dry-run：未上传。手动上传命令：')
  console.log(`gh release upload ${tag} ${stageDir}/* --clobber`)
  process.exit(0)
}

const probe = spawnSync('gh', ['--version'], { encoding: 'utf8' })
if (probe.status !== 0) {
  console.error('\n未找到 gh（GitHub CLI）：请安装并 gh auth login，或手动上传上面的文件。')
  process.exit(1)
}

const files = [asciiExe, asciiSig, 'latest.json'].map((name) => join(stageDir, name))
const exists = spawnSync('gh', ['release', 'view', tag, '--repo', repo], {
  encoding: 'utf8',
  cwd: root,
})
const args =
  exists.status === 0
    ? ['release', 'upload', tag, ...files, '--clobber', '--repo', repo]
    : [
        'release',
        'create',
        tag,
        ...files,
        '--repo',
        repo,
        '--title',
        `${tag} · 络雀`,
        '--notes',
        notes,
      ]
const result = spawnSync('gh', args, { stdio: 'inherit', cwd: root })
if (result.status !== 0) process.exit(result.status ?? 1)

console.log(`\n已发布 ${tag}：应用下次启动（或设置里点「检查更新」）即可收到。`)
