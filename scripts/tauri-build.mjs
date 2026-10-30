#!/usr/bin/env node
/**
 * 构建安装包：注入更新签名私钥 → tauri build → 收集安装包。
 *
 * 为什么需要这层包装：`bundle.createUpdaterArtifacts` 打开后，Tauri 每次打包
 * 都必须拿到 minisign 私钥，否则直接报错退出。私钥只在本地 `desktop/signing/`
 * （`.gitignore` 已忽略），这里按路径交给 Tauri，避免每次手动 export。
 *
 * 用法：pnpm tauri:build（等价于 node scripts/tauri-build.mjs）
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import console from 'node:console'
import process from 'node:process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const keyPath = join(root, 'desktop', 'signing', 'updater.key')

if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  if (!existsSync(keyPath)) {
    console.error(
      `缺少更新签名私钥：${keyPath}\n` +
        '生成一次即可：pnpm tauri signer generate -w desktop/signing/updater.key\n' +
        '注意：私钥丢失后已安装的客户端只能手动重装一次，务必离线备份。',
    )
    process.exit(1)
  }
  process.env.TAURI_SIGNING_PRIVATE_KEY = keyPath
}

const build = spawnSync('pnpm', ['tauri', 'build', '--config', 'desktop/tauri.conf.json'], {
  stdio: 'inherit',
  cwd: root,
  env: process.env,
  shell: true,
})
if (build.status !== 0) {
  process.exit(build.status ?? 1)
}

const collect = spawnSync('node', ['scripts/collect-installer.mjs'], {
  stdio: 'inherit',
  cwd: root,
})
process.exit(collect.status ?? 1)
