import { defineConfig } from 'vitest/config';

// Password hashing (scrypt) and SQLite work make a few tests slow when the whole suite runs in parallel.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 30_000 } });
