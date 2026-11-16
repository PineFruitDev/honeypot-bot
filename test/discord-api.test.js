import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DiscordApi } from '../dist/services/DiscordApi.js';
import { Logger } from '../dist/services/Logger.js';

const GUILD = '111111111111111111';
const USER = '222222222222222222';
const URL = `https://discord.com/api/v10/guilds/${GUILD}/bans/${USER}`;
let token, unexpectedRequest;

beforeEach(() => {
  token = process.env.DISCORD_TOKEN;
  process.env.DISCORD_TOKEN = 'placeholder-test-token';
  // Every request must be explicitly mocked; no path may reach Discord.
  unexpectedRequest = mock.fn(async () => { throw new Error('Unexpected request'); });
  mock.method(globalThis, 'fetch', unexpectedRequest);
  mock.method(DiscordApi.logger, 'warn', () => {});
  mock.method(DiscordApi.logger, 'error', () => {});
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
  if (token === undefined) delete process.env.DISCORD_TOKEN;
  else process.env.DISCORD_TOKEN = token;
  assert.equal(unexpectedRequest.mock.callCount(), 0, 'unexpected requests must fail even when the caller catches them');
});

test('ban requests carry bounded purge history, a safe audit reason, and a deadline', async () => {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 204 });
  });
  for (const seconds of [-1, 0, 60, 604801]) {
    assert.equal(await DiscordApi.banMember(GUILD, USER, `spam\r\n—${'x'.repeat(500)}`, seconds), 'success');
  }
  assert.deepEqual(calls.map(({ init }) => JSON.parse(init.body).delete_message_seconds), [0, 0, 60, 604800]);
  for (const { url, init } of calls) {
    assert.equal(url, URL);
    assert.equal(init.method, 'PUT');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.headers.Authorization, 'Bot placeholder-test-token');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.headers['X-Audit-Log-Reason'].length, 400);
    assert.match(init.headers['X-Audit-Log-Reason'], /^spam---x+$/);
  }
});

for (const [status, expected] of [[403, 'missing_perms'], [404, 'error'], [429, 'error'], [500, 'error']]) {
  test(`ban HTTP ${status} is reported as ${expected} without retrying`, async () => {
    const request = mock.method(globalThis, 'fetch', async () => new Response(null, { status }));
    assert.equal(await DiscordApi.banMember(GUILD, USER, 'test'), expected);
    assert.equal(request.mock.callCount(), 1);
  });
}

test('transport failures do not reject ban or ban-state callers', async () => {
  mock.method(globalThis, 'fetch', async () => { throw new TypeError('offline'); });
  assert.equal(await DiscordApi.banMember(GUILD, USER, 'test'), 'error');
  assert.equal(await DiscordApi.isMemberBanned(GUILD, USER), null);
  assert.equal(await DiscordApi.banReason(GUILD, USER), null);
  assert.deepEqual(await DiscordApi.unbanMemberDetailed(GUILD, USER), {
    result: 'error', status: 0, threw: 'offline'
  });
});

test('missing credentials fail before any request', async () => {
  delete process.env.DISCORD_TOKEN;
  assert.equal(await DiscordApi.banMember(GUILD, USER, 'test'), 'error');
  assert.equal(await DiscordApi.isMemberBanned(GUILD, USER), null);
  assert.equal(await DiscordApi.banReason(GUILD, USER), null);
  assert.equal((await DiscordApi.unbanMemberDetailed(GUILD, USER)).status, 0);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test('unban preserves typed error details and uses bodyless DELETE', async () => {
  mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, URL);
    assert.equal(init.method, 'DELETE');
    assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(init.headers, { Authorization: 'Bot placeholder-test-token' });
    assert.equal(init.body, undefined);
    return Response.json({ code: 50013, message: 'x'.repeat(250), retry_after: 0.25 }, { status: 403 });
  });
  assert.deepEqual(await DiscordApi.unbanMemberDetailed(GUILD, USER), {
    result: 'missing_perms', status: 403, code: 50013, message: 'x'.repeat(200), retryAfter: 0.25
  });
});

test('malformed unban bodies retain HTTP classification and header backoff', async () => {
  for (const body of ['{bad', 'null', '[]', '42', '"oops"', '{"code":"50013","message":{},"retry_after":-1}']) {
    mock.method(globalThis, 'fetch', async () => new Response(body, {
      status: 429, headers: { 'retry-after': '2' }
    }));
    assert.deepEqual(await DiscordApi.unbanMemberDetailed(GUILD, USER), {
      result: 'error', status: 429, code: undefined, message: undefined, retryAfter: 2
    });
  }
});

test('invalid retry delays never become a retry deadline', async () => {
  for (const retryAfter of [0, -1, '2', null]) {
    mock.method(globalThis, 'fetch', async () => Response.json({ retry_after: retryAfter }, {
      status: 429, headers: { 'retry-after': 'not-a-delay' }
    }));
    assert.equal((await DiscordApi.unbanMemberDetailed(GUILD, USER)).retryAfter, undefined);
  }
});

test('a long rate limit returns a recovery deadline without an early retry or lookup', async () => {
  mock.method(Date, 'now', () => 1_000_000);
  const request = mock.method(globalThis, 'fetch', async () => Response.json({ retry_after: 60 }, { status: 429 }));
  const result = await DiscordApi.softbanUnban(GUILD, USER);
  assert.equal(result.unbanFailed, true);
  assert.equal(result.banState, 'unknown');
  assert.equal(result.retryAt, 1_060_000);
  assert.equal(request.mock.callCount(), 1);
});

test('repeated rate limits share one wait budget and never retry ahead of the server', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const request = mock.method(globalThis, 'fetch', async () => Response.json({ retry_after: 3 }, { status: 429 }));
  const pending = DiscordApi.softbanUnban(GUILD, USER);
  // Flush response-body parsing before advancing the mocked clock.
  await new Promise(setImmediate);
  assert.equal(request.mock.callCount(), 1);
  mock.timers.tick(2999);
  await new Promise(setImmediate);
  assert.equal(request.mock.callCount(), 1, 'the first retry must wait the full three seconds');
  mock.timers.tick(1);
  const result = await pending;
  assert.equal(request.mock.callCount(), 2, 'the second delay exceeds the remaining two-second budget');
  assert.equal(result.retryAt, 1_006_000);
  assert.equal(result.banState, 'unknown');
  assert.equal(result.unbanFailed, true);
});

test('missing unban permission stops retries and a failed lookup stays unknown', async () => {
  const methods = [];
  mock.method(globalThis, 'fetch', async (_url, init) => {
    methods.push(init.method ?? 'GET');
    if (init.method === 'DELETE') return Response.json({ code: 50013 }, { status: 403 });
    throw new Error('lookup unavailable');
  });
  const result = await DiscordApi.softbanUnban(GUILD, USER);
  assert.deepEqual(methods, ['DELETE', 'GET']);
  assert.equal(result.unbanFailed, true);
  assert.equal(result.banState, 'unknown');
  assert.match(result.detail, /missing_perms http=403 code=50013/);
});

test('ban ownership accepts only a string reason from a successful lookup', async () => {
  for (const [body, expected] of [
    [{ reason: '[honeypot:entry] test' }, '[honeypot:entry] test'],
    [{ reason: '' }, ''], [{ reason: 1 }, null], [{}, null], [null, null], [[], null]
  ]) {
    mock.method(globalThis, 'fetch', async () => Response.json(body));
    assert.equal(await DiscordApi.banReason(GUILD, USER), expected);
  }
  mock.method(globalThis, 'fetch', async () => Response.json({ reason: 'untrusted' }, { status: 403 }));
  assert.equal(await DiscordApi.banReason(GUILD, USER), null);
});

test('failed ban diagnostics redact credentials and carry the guild and user IDs', async () => {
  const lines = [];
  const logger = new Logger({ level: 'debug', sink: (_level, line) => lines.push(line) });
  mock.method(DiscordApi.logger, 'error', (...args) => logger.error(...args));
  mock.method(globalThis, 'fetch', async () => { throw new Error('Authorization: Bot placeholder-test-token'); });
  assert.equal(await DiscordApi.banMember(GUILD, USER, 'test'), 'error');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(`${GUILD}/${USER}`));
  assert.ok(!lines[0].includes('placeholder-test-token'));
});
