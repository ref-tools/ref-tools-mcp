/**
 * @fileoverview Configures Vitest for testing in the ref-tools project. Sets the root directory and enables global test variables using `defineConfig`.
 */

import { defineConfig } from 'vitest/config'

const root = process.cwd()

export default defineConfig({
  root,
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'html', 'lcov'],
      all: false,
      exclude: ['dist/**'],
    },
  },
})
