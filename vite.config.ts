import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'client',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./client', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
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
