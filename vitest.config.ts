import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Resolve the project's '@/...' path alias so tests can import app modules.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    environment: 'node',
    // `include` covers both suites; the npm scripts pass a path filter so
    // `npm test` runs only the dependency-free unit tests, while
    // `npm run test:integration` runs the local-Supabase tests.
    include: ['tests/**/*.test.ts'],
  },
})
