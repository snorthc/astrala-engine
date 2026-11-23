import { defineConfig } from 'vitest/config'

// `npm test` stays offline. `npm run test:live` hits public nodes and DEX APIs (read-only, nothing is broadcast).
export default defineConfig({
  test: { exclude: process.env.LIVE ? ['node_modules/**', 'dist/**', 'out/**', '_to_delete/**'] : ['node_modules/**', 'dist/**', 'out/**', '_to_delete/**', 'test/live/**'] }
})
