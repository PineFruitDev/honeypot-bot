/**
 * What `/honeypot setup` leaves behind when it does not arm.
 *
 * `ensureHideRole` creates a brand new role on every run, on purpose: a role that merely
 * shares the name is not proof the bot owns it. That makes the ordering of the refusals load
 * bearing, because any refusal decided after the role exists leaks one unusable **Hide
 * Honeypot** role per attempt into a server that is capped at 250 roles.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GuildConfigStore } from '../dist/services/GuildConfigStore.js';
import { HoneypotCommand } from '../dist/commands/HoneypotCommand.js';

const GUILD = '111111111111111111';

let dir;
/** Hide roles created during a run, and whether each was deleted again. */
let roles;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'honeypot-setup-'));
  GuildConfigStore.instance = null;
  await GuildConfigStore.init(dir);
  roles = [];
});

afterEach(async () => {
  await GuildConfigStore.getInstance()?.flush();
  GuildConfigStore.instance = null;
  await fs.rm(dir, { recursive: true, force: true });
});

/**
 * A guild whose own member object is absent, so every permission and hierarchy check falls
 * through to "nothing proven missing" and setup reaches the part under test.
 */
function createGuild({ createChannel } = {}) {
  const channels = new Map();
  return {
    id: GUILD,
    members: { me: null },
    roles: {
      everyone: { id: 'everyone' },
      cache: new Map(),
      create: async () => {
        const role = { id: `hide-${roles.length + 1}`, name: 'Hide Honeypot', deleted: false };
        role.delete = async () => { role.deleted = true; };
        roles.push(role);
        return role;
      }
    },
    channels: {
      cache: channels,
      create: async () => {
        const channel = await createChannel();
        channels.set(channel.id, channel);
        return channel;
      }
    }
  };
}

/** A text channel the bot can post its trap message in. */
function createTrapChannel() {
  return {
    id: 'trap-1',
    type: 0,
    send: async () => ({ id: 'sticky-1' }),
    setTopic: async () => {},
    permissionOverwrites: { edit: async () => {}, delete: async () => {} }
  };
}

/** A channel still in use, which `refuseUnsafeConversion` turns down. */
function createBusyChannel() {
  return {
    id: 'general-1',
    type: 0,
    messages: { fetch: async () => ({ filter: () => ({ size: 3 }) }) }
  };
}

function fakeInteraction({ channel = null, name = null } = {}) {
  const replies = [];
  return {
    replies,
    deferReply: async () => {},
    editReply: async payload => {
      replies.push(typeof payload === 'string' ? payload : payload.content);
    },
    options: {
      getString: key => (key === 'name' ? name : null),
      getChannel: () => channel
    }
  };
}

const runSetup = (interaction, guild) => new HoneypotCommand().setup(interaction, guild);

test('a refused conversion creates no hide role at all', async () => {
  // The likeliest way setup ends: an admin points it at a channel people are still using.
  const guild = createGuild();
  const interaction = fakeInteraction({ channel: createBusyChannel() });

  await runSetup(interaction, guild);

  assert.match(interaction.replies.at(-1), /recent messages from real people/);
  assert.deepEqual(roles, [], 'nothing is created for a setup that was never going to arm');
  assert.equal(GuildConfigStore.getInstance().getGuild(GUILD), undefined);
});

test('two refused conversions do not accumulate hide roles', async () => {
  const guild = createGuild();

  await runSetup(fakeInteraction({ channel: createBusyChannel() }), guild);
  await runSetup(fakeInteraction({ channel: createBusyChannel() }), guild);

  assert.equal(roles.length, 0, 'an admin trying candidate channels collects no orphan roles');
});

test('a setup that fails to provision discards the role it created', async () => {
  // The role exists by the time the channel creation fails, and nothing will ever reuse it:
  // ensureHideRole makes a fresh one next time, so leaving this one behind is a leak.
  const guild = createGuild({ createChannel: async () => { throw new Error('no Manage Channels'); } });
  const interaction = fakeInteraction();

  await runSetup(interaction, guild);

  assert.match(interaction.replies.at(-1), /couldn't create the channel/);
  assert.equal(roles.length, 1, 'the role had already been created');
  assert.equal(roles[0].deleted, true, 'and is cleaned up rather than left in the role list');
  assert.equal(GuildConfigStore.getInstance().getGuild(GUILD), undefined);
});

test('a setup that arms keeps its hide role', async () => {
  // The guard that matters: cleanup must never reach the role a live trap depends on, or
  // the Hide Channel button would break the moment the trap was armed.
  const guild = createGuild({ createChannel: async () => createTrapChannel() });
  const interaction = fakeInteraction();

  await runSetup(interaction, guild);

  assert.match(interaction.replies.at(-1), /Honeypot armed/);
  assert.equal(roles.length, 1);
  assert.equal(roles[0].deleted, false);
  assert.equal(GuildConfigStore.getInstance().getGuild(GUILD).hideRoleId, roles[0].id);
});
