import test from 'node:test';
import assert from 'node:assert/strict';
import { AbuseGuard } from '../dist/services/AbuseGuard.js';

test('serializes guild work while admitting another guild; deduplicates and cools users', () => {
  const guard = new AbuseGuard();
  const release = guard.acquire('a', 'u', 'e', 0);
  assert.ok(release);
  assert.equal(guard.acquire('a', 'v', 'f', 0), null);
  assert.ok(guard.acquire('b', 'u', 'g', 0));
  release();
  assert.equal(guard.acquire('a', 'u', 'h', 2000), null);
  assert.equal(guard.acquire('a', 'v', 'e', 2000), null);
  assert.ok(guard.acquire('a', 'u', 'i', 10000));
});

test('caps guild actions and global concurrency', () => {
  const guard = new AbuseGuard();
  for (let i = 0; i < 10; i++) guard.acquire('a', String(i), String(i), i * 1000)();
  assert.equal(guard.acquire('a', 'x', 'x', 11000), null);
  assert.ok(guard.acquire('a', 'x', 'x', 60000));
  for (const id of ['b', 'c', 'd']) assert.ok(guard.acquire(id, id, id, 60000));
  assert.equal(guard.acquire('e', 'e', 'e', 60000), null);
});
