// Tests for the trap's per-role hiding.
//
// The rule that matters here is what the bot is allowed to DELETE. A converted channel can
// arrive with the admin's own View-deny overwrites already on it, and this runs on every
// boot, so "remove every View-deny I don't currently want" would quietly erase server
// config the bot never created. Cleanup is driven by what the bot recorded writing.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ChannelType, Collection } from 'discord.js';
import { GuildConfigStore } from '../dist/services/GuildConfigStore.js';
import { HoneypotService } from '../dist/services/HoneypotService.js';

const GUILD = '111111111111111111';
const EVERYONE = 'everyone-role';
const HIDE_ROLE = 'hide-role';

let dataDir;
let edited;
let deleted;

/** A stand-in for the slice of a text channel that applyHideFromRoles touches. */
function createGuild(existingOverwriteIds = []) {
  edited = [];
  deleted = [];

  const overwrites = new Collection();
  for (const id of existingOverwriteIds) {
    overwrites.set(id, { type: 0, deny: { has: () => true } });
  }

  const channel = {
    id: 'trap-1',
    type: ChannelType.GuildText,
    permissionOverwrites: {
      cache: overwrites,
      edit: async (id, perms) => {
        edited.push(String(id));
        overwrites.set(String(id), { type: 0, deny: { has: () => true } });
      },
      delete: async id => {
        deleted.push(String(id));
        overwrites.delete(String(id));
      }
    }
  };

  return {
    id: GUILD,
    roles: { everyone: { id: EVERYONE } },
    channels: { cache: new Collection([['trap-1', channel]]) }
  };
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'honeypot-hide-'));
  GuildConfigStore.instance = null;
  const store = await GuildConfigStore.init(dataDir);
  await store.setTrap(GUILD, {
    channelId: 'trap-1',
    hideRoleId: HIDE_ROLE,
    createdByBot: false,
    action: 'kick'
  });
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('a configured role gets a View-deny and is recorded as applied', async () => {
  const store = GuildConfigStore.getInstance();
  await store.patchGuild(GUILD, { hideFromRoleIds: ['staff'] });

  await HoneypotService.applyHideFromRoles(createGuild());

  assert.deepEqual(edited, ['staff']);
  assert.deepEqual(deleted, []);
  assert.deepEqual(store.getGuild(GUILD).appliedHideRoleIds, ['staff']);
});

test('a role dropped from the list has its visibility override cleared', async () => {
  const store = GuildConfigStore.getInstance();
  await store.patchGuild(GUILD, { hideFromRoleIds: ['staff'], appliedHideRoleIds: ['staff'] });

  // The admin removes it from the list.
  await store.patchGuild(GUILD, { hideFromRoleIds: [] });
  await HoneypotService.applyHideFromRoles(createGuild(['staff']));

  assert.deepEqual(deleted, []);
  assert.deepEqual(edited, ['staff']);
  assert.deepEqual(store.getGuild(GUILD).appliedHideRoleIds, []);
});

test("overwrites the bot never created are left alone", async () => {
  // The regression guard. 'admins-own' is a View-deny that was on the converted channel
  // before the bot touched it, and it must survive every reconcile.
  const store = GuildConfigStore.getInstance();
  await store.patchGuild(GUILD, { hideFromRoleIds: ['staff'], appliedHideRoleIds: [] });

  await HoneypotService.applyHideFromRoles(createGuild(['admins-own']));

  assert.deepEqual(deleted, [], 'the admin\'s own overwrite was not touched');
  assert.ok(edited.includes('staff'));
});

test('reconciling repeatedly is idempotent and never starts deleting', async () => {
  const store = GuildConfigStore.getInstance();
  await store.patchGuild(GUILD, { hideFromRoleIds: ['staff'] });

  const guild = createGuild(['admins-own']);
  await HoneypotService.applyHideFromRoles(guild);
  await HoneypotService.applyHideFromRoles(guild);
  await HoneypotService.applyHideFromRoles(guild);

  assert.deepEqual(deleted, [], 'no boot ever removes the admin overwrite');
  assert.deepEqual(store.getGuild(GUILD).appliedHideRoleIds, ['staff']);
});

test('the trap\'s own overwrites are never candidates for cleanup', async () => {
  const store = GuildConfigStore.getInstance();
  // Even if these somehow end up in the lists, provisioning owns them.
  await store.patchGuild(GUILD, {
    hideFromRoleIds: [EVERYONE, HIDE_ROLE],
    appliedHideRoleIds: [EVERYONE, HIDE_ROLE]
  });

  await HoneypotService.applyHideFromRoles(createGuild([EVERYONE, HIDE_ROLE]));

  assert.deepEqual(edited, []);
  assert.deepEqual(deleted, []);
});


test('unhiding a role preserves unrelated channel permissions', async () => {
  const store = GuildConfigStore.getInstance();
  await store.patchGuild(GUILD, { hideFromRoleIds: [], appliedHideRoleIds: ['staff'] });
  const guild = createGuild(['staff']);
  const channel = guild.channels.cache.get('trap-1');
  const permissions = { ViewChannel: false, SendMessages: false, AttachFiles: true };
  channel.permissionOverwrites.edit = async (id, changes) => {
    assert.equal(id, 'staff');
    Object.assign(permissions, changes);
  };
  channel.permissionOverwrites.delete = async () => {
    for (const key of Object.keys(permissions)) delete permissions[key];
  };

  await HoneypotService.applyHideFromRoles(guild);

  assert.deepEqual(permissions, { ViewChannel: null, SendMessages: false, AttachFiles: true });
  assert.deepEqual(store.getGuild(GUILD).appliedHideRoleIds, []);
});
