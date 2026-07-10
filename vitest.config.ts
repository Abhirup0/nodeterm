import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    include: [
      'src/core/**/*.test.ts',
      'src/shared/**/*.test.ts',
      'src/main/**/*.test.ts',
      'src/renderer/**/*.test.ts',
      'src/server/**/*.test.ts',
      'test/server/**/*.test.ts',
      'test/remote/**/*.test.ts'
    ],
    environment: 'node'
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer')
    }
  }
})
