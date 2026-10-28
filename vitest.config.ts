import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * 前端单测：只跑 `client/**` 下的纯逻辑（domain 层）与组件外的工具函数。
 * 画布交互依赖 Konva 与 DOM，不放进来——那部分靠真机验证。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./client', import.meta.url)),
    },
  },
  test: {
    include: ['client/**/*.test.ts'],
    environment: 'node',
  },
})
