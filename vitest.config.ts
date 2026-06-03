import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Resolve the project's '@/...' path alias so tests can import app modules.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    environment: 'node',
    // Default `npm test` runs only the dependency-free unit tests. The integration
    // tests need a running local Supabase and are run explicitly:
    //   npx vitest run tests/integration
    include: ['tests/unit/**/*.test.ts'],
  },
})
