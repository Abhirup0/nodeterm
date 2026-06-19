import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: { include: ['src/shared/**/*.test.ts'], environment: 'node' },
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } }
})
