import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/** 版本号唯一来源是 package.json，构建期注入，界面不再手写版本（避免与安装包脱节）。 */
const appVersion: string = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version

export default defineConfig({
  root: 'client',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./client', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 分包后仅剩 antd 这一个 500KB+ 的 vendor chunk（758KB，属预期），上调阈值消掉构建噪声。
    chunkSizeWarningLimit: 800,
    // 手动分包：antd / 拼音 / 画布引擎拆成独立 chunk，首屏脚本变小且可并行加载、独立缓存。
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'antd',
              test: /node_modules[\\/](antd|@ant-design|rc-[^\\/]+|@rc-component)/,
            },
            { name: 'pinyin', test: /node_modules[\\/]pinyin-pro/ },
            { name: 'canvas-engine', test: /node_modules[\\/](konva|react-konva|rbush)/ },
          ],
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
})
