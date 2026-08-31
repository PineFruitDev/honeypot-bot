// Tests for the softban, which is the part of this bot that is easy to get subtly wrong.
//
// A "kick" here is a ban with a 7-day purge followed by an unban. That second half is
// where the bugs live: if the unban is retried immediately it re-enters the same rate
// limit window Discord just told the bot to wait out, and one transient 429 turns into a
// member who is permanently banned while every log says they were kicked.
//
// These tests drive DiscordApi through a stubbed global fetch, so they cover the retry
// timing and the ban re-check without touching Discord.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { DiscordApi } from '../dist/services/DiscordApi.js';

const GUILD = '111111111111111111';
const USER = '222222222222222222';

const realFetch = globalThis.fetch;
let calls = [];

beforeEach(() => {
  calls = [];
  process.env.DISCORD_TOKEN = 'test-token';
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Stub fetch with a queue of responses for the unban DELETE, and a fixed answer for the
 * ban lookup GET. Anything past the end of the queue reuses the last entry.
 */
function stubFetch({ unbanStatuses = [], retryAfter, retryAfterInHeader = false, banLookup }) {
  globalThis.fetch = async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ method, url: String(url), at: Date.now() });

    if (method === 'DELETE') {
      const index = Math.min(
        calls.filter(call => call.method === 'DELETE').length - 1,
        unbanStatuses.length - 1
      );
      const status = unbanStatuses[index];
      if (status < 400) return new Response(null, { status });
      if (status === 429 && retryAfter !== undefined) {
        return retryAfterInHeader
          ? new Response('', { status, headers: { 'Retry-After': String(retryAfter) } })
          : new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: retryAfter }), {
              status
            });
      }
      return new Response(JSON.stringify({ code: 50013, message: 'Missing Permissions' }), { status });
    }

    if (method === 'GET') {
      return new Response(banLookup === 404 ? '{}' : JSON.stringify({ user: { id: USER } }), {
        status: banLookup ?? 200
      });
    }

    return new Response(null, { status: 204 });
  };
}

test('an unban that succeeds first time makes exactly one call and reports no failure', async () => {
  stubFetch({ unbanStatuses: [204] });

  const result = await DiscordApi.softbanUnban(GUILD, USER);

  assert.equal(result.unbanFailed, false);
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 1);
  assert.equal(calls.filter(call => call.method === 'GET').length, 0, 'no need to re-check a clean unban');
});

test('a 404 unban counts as success: there is no ban record to remove', async () => {
  stubFetch({ unbanStatuses: [404] });

  const result = await DiscordApi.softbanUnban(GUILD, USER);

  assert.equal(result.unbanFailed, false);
  assert.match(result.detail, /not_banned/);
});

test('a rate-limited unban waits out retry_after and then succeeds', async () => {
  // The regression this logic exists for. Retrying immediately would re-enter the same
  // window and fail again, making a transient limit look permanent.
  stubFetch({ unbanStatuses: [429, 204], retryAfter: 0.4 });

  const started = Date.now();
  const result = await DiscordApi.softbanUnban(GUILD, USER);
  const elapsed = Date.now() - started;

  assert.equal(result.unbanFailed, false);
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 2);
  assert.ok(elapsed >= 350, `expected to wait out the 400ms retry_after, waited ${elapsed}ms`);
});

test('retry_after delivered as a bare header is honoured too', async () => {
  // A 429 from an edge proxy carries the header and an empty body.
  stubFetch({ unbanStatuses: [429, 204], retryAfter: 0.4, retryAfterInHeader: true });

  const started = Date.now();
  const result = await DiscordApi.softbanUnban(GUILD, USER);

  assert.equal(result.unbanFailed, false);
  assert.ok(Date.now() - started >= 350, 'the header drove the backoff');
});

test('a persistently failing unban is re-checked, and reports failure when the ban is really there', async () => {
  stubFetch({ unbanStatuses: [500], banLookup: 200 });

  const result = await DiscordApi.softbanUnban(GUILD, USER);

  assert.equal(result.unbanFailed, true);
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 3, 'used the attempt budget');
  assert.match(result.detail, /still banned/);
  // The whole point of the enriched detail: the status has to reach the log.
  assert.match(result.detail, /http=500/);
});

test('a failing unban whose ban is actually gone does NOT warn staff', async () => {
  // Do not send anyone to Server Settings > Bans for a ban that is not there.
  stubFetch({ unbanStatuses: [400], banLookup: 404 });

  const result = await DiscordApi.softbanUnban(GUILD, USER);

  assert.equal(result.unbanFailed, false);
  assert.match(result.detail, /ban is gone on re-check/);
});

test('an inconclusive re-check errs toward warning staff', async () => {
  // Better an unnecessary check by a human than a member left silently banned.
  stubFetch({ unbanStatuses: [500], banLookup: 403 });

  const result = await DiscordApi.softbanUnban(GUILD, USER);

  assert.equal(result.unbanFailed, true);
  assert.match(result.detail, /inconclusive/);
});

test('a network-level failure is reported as a throw rather than swallowed', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('network error: fetch failed');
  };

  const result = await DiscordApi.softbanUnban(GUILD, USER);

  assert.equal(result.unbanFailed, true);
  assert.match(result.detail, /fetch threw/);
});
