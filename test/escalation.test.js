// Tests for the two pure rules the trap leans on: the young-account escalation and the
// channel name sanitizer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isNewAccount } from '../dist/services/EnforcementService.js';
import { sanitizeChannelName } from '../dist/services/HoneypotService.js';

const DISCORD_EPOCH = 1420070400000;

/** Build a snowflake for an account created at a given time. */
function snowflakeFor(createdMs) {
  return String((BigInt(createdMs - DISCORD_EPOCH) << 22n) | 1n);
}

test('an account created days ago is escalated', () => {
  const now = Date.UTC(2026, 0, 20);
  const threeDaysOld = snowflakeFor(now - 3 * 24 * 60 * 60 * 1000);

  assert.equal(isNewAccount(threeDaysOld, now), true);
});

test('an established account is not escalated', () => {
  const now = Date.UTC(2026, 0, 20);
  const oneYearOld = snowflakeFor(now - 365 * 24 * 60 * 60 * 1000);

  assert.equal(isNewAccount(oneYearOld, now), false);
});

test('the boundary sits exactly at seven days', () => {
  const now = Date.UTC(2026, 0, 20);
  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  assert.equal(isNewAccount(snowflakeFor(now - sevenDays + 1000), now), true);
  assert.equal(isNewAccount(snowflakeFor(now - sevenDays - 1000), now), false);
});

test('a value that is not a snowflake is never treated as new', () => {
  // Escalation only ever adds severity, so an unreadable ID has to fall back to "not new"
  // rather than banning someone because their ID failed to parse.
  assert.equal(isNewAccount('not-an-id', Date.now()), false);
  assert.equal(isNewAccount('', Date.now()), false);
});

test('channel names are normalised the way Discord would', () => {
  assert.equal(sanitizeChannelName('Do Not Enter'), 'do-not-enter');
  assert.equal(sanitizeChannelName('  Spaced  Out  '), 'spaced-out');
  assert.equal(sanitizeChannelName('emoji🍯trap'), 'emojitrap');
});

test('a name that sanitizes down to nothing falls back to the default', () => {
  assert.equal(sanitizeChannelName('🍯🍯🍯'), 'do-not-type-here');
  assert.equal(sanitizeChannelName(''), 'do-not-type-here');
});
