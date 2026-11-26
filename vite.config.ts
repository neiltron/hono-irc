import { cloudflare } from '@cloudflare/vite-plugin'
import { defineConfig } from 'vite-plus'

export default defineConfig({
  // The tests run on Node.js. The server does not depend on a runtime.
  plugins: process.env.VITEST ? [] : [cloudflare()],
  test: {
    include: ['src/**/*.test.ts'],
  },
  fmt: {
    printWidth: 100,
    semi: false,
    singleQuote: true,
    trailingComma: 'es5',
    ignorePatterns: ['dist', '**/.cloudflare'],
  },
  lint: {
    ignorePatterns: ['dist'],
    options: { typeAware: true, typeCheck: true },
  },
})
