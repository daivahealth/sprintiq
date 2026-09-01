import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the pure logic behind the dashboards — ranges, day maths,
 * label formatting. Node environment on purpose: these are the parts that can
 * be asserted without a DOM, and they are the parts where being wrong is
 * silent (a range off by one day still renders).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
