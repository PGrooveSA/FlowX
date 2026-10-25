import { defineWorkspace } from 'vitest/config';
import path from 'node:path';

const alias = { '@': path.resolve(__dirname, 'src') };

export default defineWorkspace([
  {
    resolve: { alias },
    test: {
      name: 'unit',
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
      setupFiles: ['src/test/setup.ts'],
      globals: true,
    },
  },
  {
    resolve: { alias },
    test: {
      name: 'integration',
      environment: 'node',
      include: ['tests/integration/**/*.test.ts'],
      testTimeout: 60000,
      hookTimeout: 120000,
      fileParallelism: false,
      sequence: { concurrent: false },
    },
  },
]);
