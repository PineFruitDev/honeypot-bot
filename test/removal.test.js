// Tests for `/honeypot remove` on a converted channel.
//
// Removal is the one path with no second chance. The config is the only record of which
// overwrites the bot wrote, and removal deletes it, so an overwrite that survives here
// survives forever: on a channel the admin has just been told is back to normal, with
// nothing left anywhere that knows the bot is responsible for it.

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
/** Every `permissionOverwrites.edit` the removal made, as `[roleId, changes]`. */
let edited;
/** Role IDs whose overwrite was deleted outright. */
let deleted;
/** True once the channel itself was deleted. */
let channelDeleted;

/**
 * A stand-in for the slice of a guild that `remove` touches.
 *
 * `overwrites` is what the channel currently carries per role, so a test can assert that an
 * admin's own permission bits came through the removal intact rather than only that some
 * call was made.
 */
function createGuild(overwrites = {}) {
  edited = [];
  deleted = [];
  channelDeleted = false;

  // discord.js accepts a role, a member or a bare ID here and resolves it, so the fake has
  // to as well: `remove` passes `guild.roles.everyone` itself.
  const resolveId = value =>
    value !== null && typeof value === 'object' ? String(value.id) : String(value);

  const channel = {
    id: 'trap-1',
    type: ChannelType.GuildText,
    messages: { delete: async () => {} },
    setTopic: async () => {},
    delete: async () => { channelDeleted = true; },
    permissionOverwrites: {
      edit: async (target, changes) => {
        const id = resolveId(target);
        edited.push([id, changes]);
        overwrites[id] = { ...overwrites[id], ...changes };
      },
      delete: async target => {
        const id = resolveId(target);
        deleted.push(id);
        delete overwrites[id];
      }
    }
  };

  return {
    id: GUILD,
    roles: { everyone: { id: EVERYONE }, cache: new Collection() },
    channels: { cache: new Collection([['trap-1', channel]]) },
    overwrites
  };
}

/** Arm a converted trap that is hidden from `hideFromRoleIds`, as the bot would record it. */
async function armConvertedTrap(hideFromRoleIds) {
  const store = GuildConfigStore.getInstance();
  await store.setTrap(GUILD, {
    channelId: 'trap-1',
    hideRoleId: HIDE_ROLE,
    createdByBot: false,
    messageId: 'sticky-1',
    action: 'kick'
  });
  await store.patchGuild(GUILD, {
    hideFromRoleIds,
    appliedHideRoleIds: hideFromRoleIds
  });
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'honeypot-remove-'));
  GuildConfigStore.instance = null;
  await GuildConfigStore.init(dataDir);
});

afterEach(async () => {
  await GuildConfigStore.getInstance()?.flush();
  GuildConfigStore.instance = null;
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('un-converting gives back the visibility the per-role hides took away', async () => {
  // The regression. `/honeypot config hide-from:@Members` writes a View-deny, removal hands
  // the channel back, and the role that was hidden from the trap still cannot see a channel
  // that is no longer a trap. The config that recorded the overwrite is gone with it, so
  // nothing will ever clean it up.
  await armConvertedTrap(['members']);
  const guild = createGuild({ members: { ViewChannel: false } });

  const result = await HoneypotService.remove(guild);

  assert.deepEqual(result, { removed: true, converted: true });
  assert.equal(
    guild.overwrites.members.ViewChannel,
    null,
    'the role can see the channel again'
  );
});

test('un-converting leaves the admin\'s own bits on a hidden role alone', async () => {
  // The hide was written with an edit, which merges into whatever was already there, so
  // undoing it has to clear the one bit rather than delete the overwrite.
  await armConvertedTrap(['members']);
  const guild = createGuild({
    members: { ViewChannel: false, SendMessages: false, AddReactions: true }
  });

  await HoneypotService.remove(guild);

  assert.deepEqual(guild.overwrites.members, {
    ViewChannel: null,
    SendMessages: false,
    AddReactions: true
  });
  assert.ok(!deleted.includes('members'), 'the overwrite itself is never deleted');
});

test('every role the trap was hidden from is restored, not just the first', async () => {
  await armConvertedTrap(['members', 'guests', 'bots']);
  const guild = createGuild({
    members: { ViewChannel: false },
    guests: { ViewChannel: false },
    bots: { ViewChannel: false }
  });

  await HoneypotService.remove(guild);

  for (const roleId of ['members', 'guests', 'bots']) {
    assert.equal(guild.overwrites[roleId].ViewChannel, null, `${roleId} was restored`);
  }
});

test('a role the bot never recorded hiding is not touched', async () => {
  // Cleanup stays driven by the bot's own record. A View-deny the admin put on the channel
  // themselves is not the bot's to undo, on removal any more than on a reconcile.
  const store = GuildConfigStore.getInstance();
  await armConvertedTrap(['members']);
  await store.patchGuild(GUILD, { appliedHideRoleIds: ['members'] });
  const guild = createGuild({
    members: { ViewChannel: false },
    'admins-own': { ViewChannel: false }
  });

  await HoneypotService.remove(guild);

  assert.deepEqual(guild.overwrites['admins-own'], { ViewChannel: false });
  assert.ok(
    !edited.some(([id]) => id === 'admins-own'),
    "the admin's own overwrite was never written to"
  );
});

test('the trap\'s own overwrites still go through the un-conversion, not the hide cleanup', async () => {
  // @everyone and the hide role belong to provisioning, which deletes them outright. Even
  // if they somehow end up on the applied list they must not be downgraded to a bit clear.
  await armConvertedTrap([EVERYONE, HIDE_ROLE]);
  const guild = createGuild({ [EVERYONE]: { ViewChannel: true }, [HIDE_ROLE]: { ViewChannel: false } });

  await HoneypotService.remove(guild);

  assert.deepEqual(deleted, [EVERYONE, HIDE_ROLE]);
  assert.deepEqual(edited, []);
});

test('a trap the bot created is still deleted outright, overwrites and all', async () => {
  // Nothing to restore on a channel that is about to stop existing.
  const store = GuildConfigStore.getInstance();
  await store.setTrap(GUILD, {
    channelId: 'trap-1',
    hideRoleId: HIDE_ROLE,
    createdByBot: true,
    messageId: 'sticky-1',
    action: 'kick'
  });
  await store.patchGuild(GUILD, { hideFromRoleIds: ['members'], appliedHideRoleIds: ['members'] });
  const guild = createGuild({ members: { ViewChannel: false } });

  const result = await HoneypotService.remove(guild);

  assert.deepEqual(result, { removed: true, converted: false });
  assert.equal(channelDeleted, true);
  assert.deepEqual(edited, [], 'no overwrite work on a channel being deleted');
  assert.equal(GuildConfigStore.getInstance().getGuild(GUILD), undefined);
});

test('a role the bot can no longer edit does not abort the un-conversion', async () => {
  await armConvertedTrap(['members', 'guests']);
  const guild = createGuild({ members: { ViewChannel: false }, guests: { ViewChannel: false } });
  const { permissionOverwrites } = guild.channels.cache.get('trap-1');
  const edit = permissionOverwrites.edit;
  permissionOverwrites.edit = async (target, changes) => {
    if (target === 'members') throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
    return edit(target, changes);
  };

  const result = await HoneypotService.remove(guild);

  assert.deepEqual(result, { removed: true, converted: true });
  assert.equal(guild.overwrites.guests.ViewChannel, null, 'the other role was still restored');
  assert.deepEqual(deleted, [EVERYONE, HIDE_ROLE], 'and the rest of the un-conversion ran');
});
