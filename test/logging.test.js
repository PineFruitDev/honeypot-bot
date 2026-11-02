// Tests for the one rule the logger has to hold without exception: a log line never
// carries a credential.
//
// The risk is not that someone writes `logger.info(token)`. It is that an error thrown by
// fetch or by discord.js carries the request that produced it, Authorization header and
// all, and that error gets logged whole. So these tests drive the serializer with the
// error shapes those libraries actually throw.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  Logger,
  formatFields,
  redactSecrets,
  serializeError,
  newCorrelationId
} from '../dist/services/Logger.js';

/**
 * A token-shaped string: three dot-separated segments, which is all the redactor matches
 * on. Not a real credential, and assembled at runtime rather than written out as a literal
 * so that secret scanners (correctly) do not have to decide whether it is one.
 */
const TOKEN_SHAPED = [
  'MTIzNDU2Nzg5MDEyMzQ1Njc4',
  'GaBcDe',
  'abcdefghijklmnopqrstuvwxyz123456789'
].join('.');

const realToken = process.env.DISCORD_TOKEN;

beforeEach(() => {
  delete process.env.DISCORD_TOKEN;
  process.env.LOG_FORMAT = 'json';
});

afterEach(() => {
  if (realToken === undefined) delete process.env.DISCORD_TOKEN;
  else process.env.DISCORD_TOKEN = realToken;
});

/** Collect everything written to a console method while fn runs. */
async function capture(method, fn) {
  const original = console[method];
  const lines = [];
  console[method] = (...args) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console[method] = original;
  }
  return lines.join('\n');
}

test('a token-shaped string is redacted wherever it appears', () => {
  const out = redactSecrets(`login failed for ${TOKEN_SHAPED} at the gateway`);

  assert.ok(!out.includes(TOKEN_SHAPED), 'the token must not survive');
  assert.match(out, /\[redacted\]/);
});

test('an Authorization value is redacted even when the token is an odd shape', () => {
  const out = redactSecrets('headers: { authorization: Bot abc.def }');

  assert.ok(!out.includes('abc.def'));
  assert.match(out, /authorization[:=]\s*\[redacted\]/i);
});

test('an env-style assignment of any secret-ish name is redacted', () => {
  const out = redactSecrets('DISCORD_TOKEN=short-but-real API_KEY="sk-live-123" DATA_DIR=data');

  assert.ok(!out.includes('short-but-real'));
  assert.ok(!out.includes('sk-live-123'));
  // Non-secret variables are left readable: redaction that hides everything hides nothing.
  assert.match(out, /DATA_DIR=data/);
});

test('the live token is redacted by exact match even if its shape is unusual', () => {
  process.env.DISCORD_TOKEN = 'not-token-shaped-at-all';

  const out = redactSecrets('login with not-token-shaped-at-all failed');

  assert.ok(!out.includes('not-token-shaped-at-all'));
  assert.match(out, /\[redacted\]/);
});

test('an error is reduced to allowlisted fields, dropping the request that carried a token', () => {
  // The shape discord.js throws: the error object carries the request it made.
  const error = Object.assign(new Error('Missing Permissions'), {
    code: 50013,
    status: 403,
    method: 'PUT',
    url: 'https://discord.com/api/v10/guilds/1/bans/2?with_counts=true',
    requestBody: { json: { delete_message_seconds: 604800 } },
    options: { headers: { Authorization: `Bot ${TOKEN_SHAPED}` } },
    rawError: { code: 50013, message: 'Missing Permissions' }
  });

  const serialized = serializeError(error);
  const printed = JSON.stringify(serialized);

  assert.equal(serialized.code, 50013);
  assert.equal(serialized.status, 403);
  assert.equal(serialized.method, 'PUT');
  assert.equal(serialized.message, 'Missing Permissions');

  // The fields that carry credentials and user content are gone entirely.
  assert.equal(serialized.options, undefined, 'options can hold the Authorization header');
  assert.equal(serialized.requestBody, undefined, 'the request body can hold user content');
  assert.equal(serialized.rawError, undefined);
  assert.ok(!printed.includes(TOKEN_SHAPED));
  assert.ok(!printed.includes('Authorization'));
});

test('a URL keeps its path and loses its query string', () => {
  const error = Object.assign(new Error('nope'), {
    url: 'https://discord.com/api/v10/guilds/1/bans/2?token=secret-value'
  });

  const serialized = serializeError(error);

  assert.equal(serialized.url, 'https://discord.com/api/v10/guilds/1/bans/2');
  assert.ok(!JSON.stringify(serialized).includes('secret-value'));
});

test('a nested cause is serialized through the same allowlist', () => {
  const error = new Error('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
      syscall: 'connect',
      secretHeaders: { Authorization: `Bot ${TOKEN_SHAPED}` }
    })
  });

  const serialized = serializeError(error);

  assert.equal(serialized.cause.code, 'ECONNREFUSED');
  assert.equal(serialized.cause.syscall, 'connect');
  assert.equal(serialized.cause.secretHeaders, undefined);
  assert.ok(!JSON.stringify(serialized).includes(TOKEN_SHAPED));
});

test('something thrown that is not an Error is reported as such', () => {
  const serialized = serializeError('just a string');

  assert.equal(serialized.name, 'NonError');
  assert.equal(serialized.message, 'just a string');
});

test('nothing thrown serializes to nothing', () => {
  assert.deepEqual(serializeError(undefined), {});
  assert.deepEqual(serializeError(null), {});
});

test('a log line carries its correlation, guild and action fields', async () => {
  const logger = new Logger({ context: 'Test' }).child({
    correlationId: 'abc1234567',
    guildId: '111111111111111111'
  });

  const output = await capture('error', () => {
    logger.error('handleCatch - Action FAILED', undefined, { action: 'kick', result: 'error' });
  });

  assert.ok(output.includes('handleCatch - Action FAILED'));
  const entry = JSON.parse(output);
  const fields = { ...entry, ...Object.assign({}, ...(entry.details ?? []).map(value => JSON.parse(value))) };
  assert.equal(fields.correlationId, 'abc1234567');
  assert.equal(fields.guildId, '111111111111111111');
  assert.equal(fields.action, 'kick');
  assert.equal(fields.result, 'error');
});

test('an error passed as the second argument is folded into the error field, not printed whole', async () => {
  const logger = new Logger({ context: 'Test' });
  const error = Object.assign(new Error('boom'), {
    options: { headers: { Authorization: `Bot ${TOKEN_SHAPED}` } }
  });

  const output = await capture('warn', () => {
    logger.warn('something - went sideways', error);
  });

  assert.ok(!output.includes(TOKEN_SHAPED));
  const entry = JSON.parse(output);
  const fields = { ...entry, ...Object.assign({}, ...(entry.details ?? []).map(value => JSON.parse(value))) };
  assert.equal(fields.error.message, 'boom');
  assert.equal(fields.error.options, undefined);
});

test('a stack is trimmed rather than dumped', () => {
  const serialized = serializeError(new Error('deep'));

  assert.ok(Array.isArray(serialized.stack));
  assert.ok(serialized.stack.length <= 3, 'three frames name the path without a wall of text');
});

test('structured fields are swept for secrets too', () => {
  const printed = formatFields({ guildId: '1', detail: `used ${TOKEN_SHAPED} to authenticate` });

  assert.ok(!printed.includes(TOKEN_SHAPED));
  assert.match(printed, /\[redacted\]/);
});

test('field serialization never throws on a circular object', () => {
  const circular = { name: 'loop' };
  circular.self = circular;

  assert.doesNotThrow(() => formatFields({ circular }));
});

test('a correlation ID is short, opaque and unique enough to quote to a user', () => {
  const first = newCorrelationId();
  const second = newCorrelationId();

  assert.match(first, /^[0-9a-f]{10}$/);
  assert.notEqual(first, second);
});
