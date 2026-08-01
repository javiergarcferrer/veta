import { test } from 'node:test';
test('package resolves', async () => { await import('../src/index.ts'); });
