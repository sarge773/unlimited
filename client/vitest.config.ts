// Standalone vitest config so tests don't load vite.config.ts (whose React +
// Tailwind plugins are pointless for unit tests). Most tests are plain
// TypeScript and run in the default node environment — no jsdom.
//
// The exception is the chart-axis render test, which mounts a real recharts
// chart to prove the axis props actually reach recharts. That single file
// opts into jsdom with an `@vitest-environment jsdom` docblock, so we only pay
// for a DOM where one is genuinely needed.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // esbuild only reads the *nearest* tsconfig.json, and ours is a solution
  // file (`files: []` + project references), so `jsx: react-jsx` from
  // tsconfig.app.json never reaches it. Say it here instead.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
