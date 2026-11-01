// Tests for startup configuration validation: that a bad environment stops the bot before
// it talks to Discord, that one failure reports every broken key at once, and above all
// that no error message ever contains a configured value.
//
// Every token-shaped string in this file is fabricated. Nothing here is a real credential.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  Environment,
  ConfigValidationError,
  CONFIG_KEYS
} from '../dist/services/Environment.js';

/** Shaped like a Discord bot token (three dot-separated segments, over 50 chars), but fake. */
const FAKE_TOKEN = `${'A'.repeat(26)}.${'Bbcdef'}.${'C'.repeat(38)}`;
const CLIENT_ID = '123456789012345678';
const DEV_ID = '987654321098765432';

let savedEnv;
let savedConsole;

/** Replace the environment wholesale so a stray value on the machine cannot pass a test. */
function setEnv(values) {
  for (const key of CONFIG_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

/** A minimal environment that should validate cleanly. */
function validEnv(overrides = {}) {
  return { DISCORD_TOKEN: FAKE_TOKEN, DISCORD_CLIENT_ID: CLIENT_ID, ...overrides };
}

/** Validate and return the error, asserting that one was thrown at all. */
function expectFailure(values) {
  setEnv(values);
  try {
    Environment.validate();
  } catch (error) {
    assert.ok(error instanceof ConfigValidationError, 'fails with a config error');
    return error;
  }
  assert.fail('expected validation to fail');
}

beforeEach(() => {
  savedEnv = { ...process.env };
  Environment.reset();

  // Validation logs, and most of these tests make it log a failure. Keep the suite readable.
  savedConsole = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
});

afterEach(() => {
  Object.assign(console, savedConsole);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  Environment.reset();
});

test('a complete environment resolves with the documented defaults', () => {
  setEnv(validEnv());
  const config = Environment.validate();

  assert.equal(config.discordToken, FAKE_TOKEN);
  assert.equal(config.discordClientId, CLIENT_ID);
  assert.equal(config.nodeEnv, 'production', 'NODE_ENV defaults to production');
  assert.equal(config.dataDir, 'data');
  assert.equal(config.registerOnBoot, true);
  assert.deepEqual(config.developerIds, []);
  assert.equal(config.isProduction, true);
  assert.equal(config.isDevelopment, false);
});

test('every missing required key is named in one failure', () => {
  const error = expectFailure({});

  assert.deepEqual(error.keys.sort(), ['DISCORD_CLIENT_ID', 'DISCORD_TOKEN']);
  assert.match(error.message, /DISCORD_TOKEN: is required but not set/);
  assert.match(error.message, /DISCORD_CLIENT_ID: is required but not set/);
});

test('a key present but blank counts as missing', () => {
  const error = expectFailure(validEnv({ DISCORD_TOKEN: '   \t ' }));
  assert.deepEqual(error.keys, ['DISCORD_TOKEN']);
  assert.match(error.message, /is required but not set/);
});

test('a malformed token is rejected by shape', () => {
  for (const token of ['not-a-token', 'a.b', `${'A'.repeat(60)}`, `${'A'.repeat(20)}..${'C'.repeat(30)}`]) {
    const error = expectFailure(validEnv({ DISCORD_TOKEN: token }));
    assert.deepEqual(error.keys, ['DISCORD_TOKEN'], `rejects a ${token.length}-char token`);
    Environment.reset();
  }
});

test('a token short enough to be a truncated paste is rejected', () => {
  const error = expectFailure(validEnv({ DISCORD_TOKEN: 'AAAA.BBBB.CCCC' }));
  assert.match(error.message, /DISCORD_TOKEN: is too short/);
});

test('a "Bot " prefix on the token is called out specifically', () => {
  const error = expectFailure(validEnv({ DISCORD_TOKEN: `Bot ${FAKE_TOKEN}` }));
  assert.match(error.message, /DISCORD_TOKEN: has a "Bot " prefix/);
});

test('a quoted value is called out rather than passed through', () => {
  const error = expectFailure(validEnv({ DISCORD_CLIENT_ID: `"${CLIENT_ID}"` }));
  assert.match(error.message, /DISCORD_CLIENT_ID: is wrapped in quotes/);
});

test('an unedited copy of .env.example is caught as a placeholder', () => {
  const error = expectFailure({
    DISCORD_TOKEN: 'your_bot_token_here',
    DISCORD_CLIENT_ID: 'your_bot_client_id_here'
  });

  assert.deepEqual(error.keys.sort(), ['DISCORD_CLIENT_ID', 'DISCORD_TOKEN']);
  assert.match(error.message, /DISCORD_TOKEN: is still the placeholder/);
  assert.match(error.message, /DISCORD_CLIENT_ID: is still the placeholder/);
});

test('a client ID that is not a snowflake is rejected', () => {
  for (const id of ['12345', 'abcdefghijklmnopqr', '1234567890123456789012']) {
    const error = expectFailure(validEnv({ DISCORD_CLIENT_ID: id }));
    assert.match(error.message, /DISCORD_CLIENT_ID: is not a Discord ID/);
    Environment.reset();
  }
});

test('a bad developer ID is reported by position, not by value', () => {
  const error = expectFailure(
    validEnv({ DISCORD_CLIENT_ID: CLIENT_ID, DEVELOPER_IDS: `${DEV_ID},nope,${DEV_ID}` })
  );

  assert.deepEqual(error.keys, ['DEVELOPER_IDS']);
  assert.match(error.message, /entry at position 2/);
  assert.ok(!error.message.includes('nope'), 'the offending entry is not quoted back');
});

test('several bad developer IDs list every position', () => {
  const error = expectFailure(validEnv({ DEVELOPER_IDS: `bad-one,${DEV_ID},bad-two` }));
  assert.match(error.message, /entries at position 1, 3/);
});

test('developer IDs are parsed, trimmed and deduplicated', () => {
  setEnv(validEnv({ DEVELOPER_IDS: ` ${DEV_ID} , ${CLIENT_ID},${DEV_ID}, ` }));
  const config = Environment.validate();
  assert.deepEqual(config.developerIds, [DEV_ID, CLIENT_ID]);
});

test('NODE_ENV is restricted to the environments the bot knows about', () => {
  const error = expectFailure(validEnv({ NODE_ENV: 'staging' }));
  assert.match(error.message, /NODE_ENV: is not one of development, production, test/);
});

test('NODE_ENV is normalized and drives the derived flags', () => {
  setEnv(validEnv({ NODE_ENV: 'Development' }));
  const config = Environment.validate();

  assert.equal(config.nodeEnv, 'development');
  assert.equal(config.isDevelopment, true);
  assert.equal(config.isProduction, false);
  assert.equal(process.env.NODE_ENV, 'development', 'direct readers see the normalized value');
});

test('REGISTER_ON_BOOT accepts the usual spellings of a boolean', () => {
  for (const [raw, expected] of [
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['yes', true],
    ['false', false],
    ['False', false],
    ['0', false],
    ['off', false]
  ]) {
    Environment.reset();
    setEnv(validEnv({ REGISTER_ON_BOOT: raw }));
    assert.equal(Environment.validate().registerOnBoot, expected, `${raw} parses as ${expected}`);
  }
});

test('a non-boolean REGISTER_ON_BOOT fails instead of being read as false', () => {
  const error = expectFailure(validEnv({ REGISTER_ON_BOOT: 'maybe' }));
  assert.match(error.message, /REGISTER_ON_BOOT: is not a boolean/);
});

test('a DATA_DIR that cannot be a path is rejected', () => {
  const error = expectFailure(validEnv({ DATA_DIR: 'data\nmore' }));
  assert.match(error.message, /DATA_DIR: contains a line break/);
});

test('no configured value appears anywhere in the failure message', () => {
  // Distinctive values across every key at once, so a leak from any one of them shows up.
  const hostile = {
    DISCORD_TOKEN: 'leaked-token-9f3Qx7LpZ',
    DISCORD_CLIENT_ID: 'leaked-client-4Kd82',
    NODE_ENV: 'leaked-env-Vb91',
    DATA_DIR: 'leaked-dir-\nMq44',
    REGISTER_ON_BOOT: 'leaked-bool-Zt06',
    DEVELOPER_IDS: 'leaked-dev-Hn73'
  };

  const error = expectFailure(hostile);

  assert.deepEqual(error.keys.sort(), [...CONFIG_KEYS].sort(), 'all six keys are reported');
  for (const [key, value] of Object.entries(hostile)) {
    assert.ok(error.message.includes(key), `${key} is named`);
    assert.ok(!error.message.includes(value), `${key}'s value is not echoed back`);
  }
});

test('validation happens once and the result is frozen', () => {
  setEnv(validEnv());
  const first = Environment.validate();

  // A later edit to the environment must not change what the bot is already running with.
  process.env.DATA_DIR = 'somewhere-else';
  process.env.DISCORD_TOKEN = '';

  const second = Environment.validate();
  assert.equal(second, first, 'the same object comes back');
  assert.equal(second.dataDir, 'data', 'the resolved value is not re-read');
  assert.equal(Object.isFrozen(second), true);
  assert.throws(() => {
    second.dataDir = 'mutated';
  }, TypeError);
});

test('getConfig validates on first use rather than handing back raw env', () => {
  const error = expectFailure({});
  assert.ok(error instanceof ConfigValidationError);

  Environment.reset();
  setEnv(validEnv({ DATA_DIR: 'custom-data' }));
  assert.equal(Environment.getConfig().dataDir, 'custom-data');

  Environment.reset();
  setEnv({});
  assert.throws(() => Environment.getConfig(), ConfigValidationError);
});

test('the startup summary never reproduces the token', () => {
  const written = [];
  console.log = (...args) => written.push(args.join(' '));

  setEnv(validEnv({ DEVELOPER_IDS: DEV_ID }));
  Environment.validate();

  const output = written.join('\n');
  assert.ok(output.includes('Discord token: present'), 'presence is reported');
  assert.ok(!output.includes(FAKE_TOKEN), 'the token is not logged');
  // Not even the ends of it: a masked secret is still part of a live credential.
  assert.ok(!output.includes(FAKE_TOKEN.slice(0, 6)), 'nor the start of it');
  assert.ok(!output.includes(FAKE_TOKEN.slice(-6)), 'nor the end of it');
  assert.ok(output.includes('Developer IDs configured: 1'), 'IDs are counted, not listed');
  assert.ok(!output.includes(DEV_ID), 'and not listed');
});
