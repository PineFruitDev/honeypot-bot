// Tests for `/honeypot config hide-from:`.
//
// applyHideFromRoles owns the trap's own two overwrites and refuses to touch either of them:
// a View-deny for @everyone would hide the trap from the bots it exists to catch, and the
// hide role already denies View. The command has to refuse those two roles for the same
// reason, because storing one confirms a hide that never happens and leaves an entry
// `/honeypot status` reports as hidden for good.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GuildConfigStore } from '../dist/services/GuildConfigStore.js';
import { HoneypotCommand } from '../dist/commands/HoneypotCommand.js';

const GUILD = '111111111111111111';
const EVERYONE = 'everyone-role';
const HIDE_ROLE = 'hide-role';

let dataDir;

/** The slice of a guild that the config subcommand reads. */
function createGuild() {
  return {
    id: GUILD,
    roles: { everyone: { id: EVERYONE } },
    // Left empty on purpose: applyHideFromRoles finds no trap channel and returns, so these
    // tests assert what the command stores and says rather than re-testing the service.
    channels: { cache: new Map() }
  };
}

/** A fake interaction that records every reply the command sends. */
function createInteraction(roles = {}) {
  const replies = [];
  return {
    replies,
    deferReply: async () => {},
    editReply: async payload => {
      replies.push(typeof payload === 'string' ? payload : payload.content);
    },
    options: {
      getString: () => null,
      getChannel: () => null,
      getUser: () => null,
      getRole: name => roles[name] ?? null
    }
  };
}

const run = interaction => new HoneypotCommand().config(interaction, createGuild());

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'honeypot-config-hide-'));
  GuildConfigStore.instance = null;
  const store = await GuildConfigStore.init(dataDir);
  await store.setTrap(GUILD, {
    channelId: 'trap-1',
    hideRoleId: HIDE_ROLE,
    createdByBot: false,
    messageId: 'warning-1',
    action: 'kick'
  });
});

afterEach(async () => {
  GuildConfigStore.instance = null;
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('hiding the trap from @everyone is refused rather than silently dropped', async () => {
  const interaction = createInteraction({
    'hide-from': { id: EVERYONE, name: '@everyone' }
  });

  await run(interaction);

  assert.equal(interaction.replies.length, 1);
  assert.match(interaction.replies[0], /has to stay visible/);
  // Never confirmed as done, and never left in the config for status to report.
  assert.doesNotMatch(interaction.replies[0], /is now hidden from/);
  assert.deepEqual(
    GuildConfigStore.getInstance().getGuild(GUILD).hideFromRoleIds ?? [],
    [],
    '@everyone must not be stored as a hidden role'
  );
});

test('hiding the trap from its own hide role is refused', async () => {
  const interaction = createInteraction({
    'hide-from': { id: HIDE_ROLE, name: 'Hide Honeypot' }
  });

  await run(interaction);

  assert.equal(interaction.replies.length, 1);
  assert.match(interaction.replies[0], /already hands out/);
  assert.deepEqual(GuildConfigStore.getInstance().getGuild(GUILD).hideFromRoleIds ?? [], []);
});

test('an ordinary role is still hidden and confirmed', async () => {
  const interaction = createInteraction({
    'hide-from': { id: 'newbies', name: 'Newbies' }
  });

  await run(interaction);

  assert.match(interaction.replies[0], /now hidden from \*\*Newbies\*\*/);
  assert.deepEqual(GuildConfigStore.getInstance().getGuild(GUILD).hideFromRoleIds, ['newbies']);
});

test('show-to still clears a reserved role an earlier version stored', async () => {
  const store = GuildConfigStore.getInstance();
  await store.patchGuild(GUILD, { hideFromRoleIds: [EVERYONE, 'newbies'] });

  const interaction = createInteraction({ 'show-to': { id: EVERYONE, name: '@everyone' } });
  await run(interaction);

  assert.deepEqual(store.getGuild(GUILD).hideFromRoleIds, ['newbies']);
});
