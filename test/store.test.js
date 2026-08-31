// Tests for the persisted trap config: that it survives a restart, that the lifetime
// catch total outlives the trimmed history, and that a re-setup does not wipe the
// settings an admin configured separately.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GuildConfigStore } from '../dist/services/GuildConfigStore.js';

const GUILD = '111111111111111111';
let dataDir;

/**
 * A fresh store instance backed by a fresh temp directory.
 *
 * The store is a process-wide singleton, and `init` hands back the existing instance if
 * there is one. Nulling the field is deliberate: it is private in TypeScript but a plain
 * property at runtime, and it is the only way to get an isolated store per test. Do not
 * "fix" this without giving the store a real reset.
 */
async function freshStore() {
  GuildConfigStore.instance = null;
  return GuildConfigStore.init(dataDir);
}

/** Re-init from disk, as a restart would. */
async function reopenStore() {
  GuildConfigStore.instance = null;
  return GuildConfigStore.init(dataDir);
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'honeypot-store-'));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('a trap survives a restart', async () => {
  const store = await freshStore();
  await store.setTrap(GUILD, {
    channelId: 'chan-1',
    hideRoleId: 'role-1',
    createdByBot: true,
    messageId: 'msg-1',
    action: 'ban'
  });

  const reopened = await reopenStore();
  const config = reopened.getGuild(GUILD);

  assert.equal(config.channelId, 'chan-1');
  assert.equal(config.action, 'ban');
  assert.equal(config.createdByBot, true);
  assert.ok(reopened.isTrapChannel(GUILD, 'chan-1'));
  assert.ok(!reopened.isTrapChannel(GUILD, 'chan-2'));
});

test('re-running setup keeps the settings that are configured separately', async () => {
  const store = await freshStore();
  await store.setTrap(GUILD, { channelId: 'chan-1', action: 'kick' });
  await store.patchGuild(GUILD, {
    logChannelId: 'log-1',
    exemptRoleIds: ['mods'],
    hideFromRoleIds: ['newbies']
  });

  // A second setup replaces the trap itself but must not silently discard the rest.
  await store.setTrap(GUILD, { channelId: 'chan-2', action: 'ban' });
  const config = store.getGuild(GUILD);

  assert.equal(config.channelId, 'chan-2');
  assert.equal(config.logChannelId, 'log-1');
  assert.deepEqual(config.exemptRoleIds, ['mods']);
  assert.deepEqual(config.hideFromRoleIds, ['newbies']);
});

test('the lifetime total keeps counting after the history is trimmed', async () => {
  const store = await freshStore();
  await store.setTrap(GUILD, { channelId: 'chan-1', action: 'kick' });

  // More catches than the retained history, so the two numbers have to diverge.
  for (let i = 0; i < 60; i++) {
    await store.recordCatch(GUILD, {
      userId: `user-${i}`,
      userTag: `user${i}#0001`,
      action: 'kick',
      escalated: false,
      source: 'message',
      caughtAt: new Date().toISOString()
    });
  }

  assert.equal(store.getCatchTotal(GUILD), 60, 'the counter shows every catch ever');
  assert.equal(store.getGuild(GUILD).catches.length, 50, 'the stored history is capped');

  const reopened = await reopenStore();
  assert.equal(reopened.getCatchTotal(GUILD), 60, 'and the total survives a restart');
});

test('recent catches come back newest first', async () => {
  const store = await freshStore();
  await store.setTrap(GUILD, { channelId: 'chan-1', action: 'kick' });

  for (const id of ['a', 'b', 'c']) {
    await store.recordCatch(GUILD, {
      userId: id,
      userTag: `${id}#0001`,
      action: 'kick',
      escalated: false,
      source: 'message',
      caughtAt: new Date().toISOString()
    });
  }

  assert.deepEqual(
    store.getRecentCatches(GUILD, 2).map(record => record.userId),
    ['c', 'b']
  );
});

test('removing a guild forgets the trap and its counter', async () => {
  const store = await freshStore();
  await store.setTrap(GUILD, { channelId: 'chan-1', action: 'kick' });
  await store.recordCatch(GUILD, {
    userId: 'u',
    userTag: 'u#1',
    action: 'kick',
    escalated: false,
    source: 'button',
    caughtAt: new Date().toISOString()
  });

  await store.removeGuild(GUILD);

  const reopened = await reopenStore();
  assert.equal(reopened.getGuild(GUILD), undefined);
  assert.equal(reopened.getCatchTotal(GUILD), 0);
});

test('a missing config file starts clean instead of throwing', async () => {
  const store = await freshStore();
  assert.deepEqual(store.getAllGuilds(), []);
});
