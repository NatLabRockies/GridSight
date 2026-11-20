import { defineConfig } from 'vitest/config';

/**
 * Vitest config — currently scoped to the pure reducers under
 * ``src/state/``. They have no React or DOM deps so the default
 * 'node' environment is fine and tests stay fast.
 *
 * If we ever want component tests, add ``environment: 'jsdom'`` and
 * an ``@testing-library/react`` setup file.
 */
export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.{test,spec}.{js,jsx}'],
    environment: 'node',
    globals: false,
  },
});
