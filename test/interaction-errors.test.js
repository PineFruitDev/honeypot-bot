// Tests for what a person sees when something goes wrong.
//
// A failed interaction has two audiences. The log gets the detail; the user gets one
// ephemeral line and a reference they can quote to staff. The failure modes these cover
// are the ones that produced nothing at all before: a press on a trap that has since been
// removed, a handler that threw, and a role add slow enough to outlive the three second
// interaction window.
//
// Interactions are faked and dispatched through the client's own event emitter, so the
// real listener and the real boundary run.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Events, GuildMember } from 'discord.js';

import { Bot } from '../dist/core/Bot.js';
import { GuildConfigStore } from '../dist/services/GuildConfigStore.js';
import { PendingActionStore } from '../dist/services/PendingActionStore.js';
import { BUTTON_IDS } from '../dist/config/honeypotText.js';

const GUILD = '111111111111111111';
const USER = '333333333333333333';
const HIDE_ROLE = 'hide-role';

/** MessageFlags.Ephemeral. Every error a user sees has to carry this. */
const EPHEMERAL = 64;

let dataDir;
let bot;

/** A guild stub that only has to answer the lookups the interaction path makes. */
function fakeGuild() {
  return {
    id: GUILD,
    name: 'Test Guild',
    ownerId: 'owner',
    members: { me: null },
    client: { user: { id: 'bot-user' } },
    channels: { cache: new Map() },
    roles: { cache: new Map([[HIDE_ROLE, { id: HIDE_ROLE, name: 'Hide Honeypot' }]]) }
  };
}

/** A button interaction that records everything sent back to the user. */
function fakeButton(customId, { member = null } = {}) {
  const sent = [];
  const interaction = {
    type: 3,
    id: 'interaction-1',
    channelId: 'trap-channel',
    message: { id: 'sticky-1' },
    customId,
    guild: fakeGuild(),
    guildId: GUILD,
    user: { id: USER, tag: 'curious#0001' },
    member,
    replied: false,
    deferred: false,
    /** Order matters: whether the defer happened before the REST work is the assertion. */
    events: [],
    sent,
    isButton: () => true,
    isChatInputCommand: () => false,
    isRepliable: () => true,
    async deferReply(payload) {
      interaction.deferred = true;
      interaction.events.push('defer');
      sent.push({ kind: 'defer', ...payload });
    },
    async reply(payload) {
      interaction.replied = true;
      interaction.events.push('reply');
      sent.push({ kind: 'reply', ...payload });
    },
    async followUp(payload) {
      interaction.events.push('followUp');
      sent.push({ kind: 'followUp', ...payload });
    },
    async editReply(payload) {
      interaction.events.push('editReply');
      sent.push({ kind: 'editReply', ...payload });
    }
  };
  return interaction;
}

/** A member that passes `instanceof GuildMember`, with a role add that can be rigged. */
function fakeMember(addImpl) {
  const member = Object.create(GuildMember.prototype);
  Object.defineProperty(member, 'id', { value: USER });
  Object.defineProperty(member, 'roles', { value: { add: addImpl } });
  return member;
}

/** Poll until the detached interaction handler has produced a response. */
async function waitFor(predicate, description) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${description}`);
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'honeypot-interactions-'));
  GuildConfigStore.instance = null;
  PendingActionStore.instance = null;
  await GuildConfigStore.init(dataDir);
  await PendingActionStore.init(dataDir);
  bot = new Bot('unused-token');
  bot.markReady();
});

afterEach(async () => {
  await bot.stop().catch(() => {});
  GuildConfigStore.instance = null;
  PendingActionStore.instance = null;
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('a button on a trap that has been removed gets an answer, not silence', async () => {
  // No trap configured for this guild: the buttons are left over on an old message.
  const interaction = fakeButton(BUTTON_IDS.stats);

  bot.getClient().emit(Events.InteractionCreate, interaction);
  await waitFor(() => interaction.sent.length, 'a reply to the stale button');

  assert.equal(interaction.sent[0].flags, EPHEMERAL, 'errors are never public in the trap');
  assert.match(interaction.sent[0].content, /no longer set up/);
});

test('a handler that throws still answers the user, with a reference for staff', async () => {
  const store = GuildConfigStore.getInstance();
  await store.setTrap(GUILD, { channelId: 'trap-channel', messageId: 'sticky-1', action: 'kick' });
  store.getCatchTotal = () => {
    throw new Error('the stats read blew up');
  };

  const interaction = fakeButton(BUTTON_IDS.stats);
  bot.getClient().emit(Events.InteractionCreate, interaction);
  await waitFor(() => interaction.sent.length, 'an error reply');

  const reply = interaction.sent.at(-1);
  assert.equal(reply.flags, EPHEMERAL);
  assert.match(reply.content, /Something went wrong/);
  // The reference is the same ID the log line carries, which is the whole point of it.
  assert.match(reply.content, /reference `[0-9a-f]{10}`/);
});

test('the hide button defers before it touches the Discord API', async () => {
  const store = GuildConfigStore.getInstance();
  await store.setTrap(GUILD, { channelId: 'trap-channel', messageId: 'sticky-1', hideRoleId: HIDE_ROLE, action: 'kick' });

  let deferredFirst = false;
  const interaction = fakeButton(BUTTON_IDS.hide, {
    member: fakeMember(async () => {
      // Adding a role is a round trip. If the interaction was not acknowledged first, a
      // slow one expires at three seconds and the press looks like it did nothing.
      deferredFirst = interaction.deferred;
    })
  });

  bot.getClient().emit(Events.InteractionCreate, interaction);
  await waitFor(() => interaction.events.includes('editReply'), 'the hide confirmation');

  assert.equal(deferredFirst, true, 'the defer has to come before the role add');
  assert.deepEqual(interaction.events, ['defer', 'editReply']);
  assert.match(interaction.sent.at(-1).content, /Hidden/);
});

test('a hide that fails tells the user what to ask an admin for', async () => {
  const store = GuildConfigStore.getInstance();
  await store.setTrap(GUILD, { channelId: 'trap-channel', messageId: 'sticky-1', hideRoleId: HIDE_ROLE, action: 'kick' });

  const interaction = fakeButton(BUTTON_IDS.hide, {
    member: fakeMember(async () => {
      throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
    })
  });

  bot.getClient().emit(Events.InteractionCreate, interaction);
  await waitFor(() => interaction.events.includes('editReply'), 'the failure reply');

  assert.match(interaction.sent.at(-1).content, /Manage Roles/);
});

test('a hide with no role configured answers instead of leaving the press hanging', async () => {
  const store = GuildConfigStore.getInstance();
  // A trap set up before the hide role existed, or one whose role was deleted.
  await store.setTrap(GUILD, { channelId: 'trap-channel', messageId: 'sticky-1', action: 'kick' });

  const interaction = fakeButton(BUTTON_IDS.hide, { member: fakeMember(async () => {}) });
  bot.getClient().emit(Events.InteractionCreate, interaction);
  await waitFor(() => interaction.events.includes('editReply'), 'the failure reply');

  assert.match(interaction.sent.at(-1).content, /Manage Roles/);
});

test('an interaction that dies mid-reply does not take the process down', async () => {
  const store = GuildConfigStore.getInstance();
  await store.setTrap(GUILD, { channelId: 'trap-channel', messageId: 'sticky-1', action: 'kick' });
  store.getCatchTotal = () => {
    throw new Error('the stats read blew up');
  };

  const interaction = fakeButton(BUTTON_IDS.stats);
  // 10062 Unknown interaction: the user waited too long and there is nothing to reply to.
  interaction.reply = async () => {
    throw Object.assign(new Error('Unknown interaction'), { code: 10062 });
  };

  const rejections = [];
  const onRejection = reason => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    bot.getClient().emit(Events.InteractionCreate, interaction);
    await new Promise(resolve => setTimeout(resolve, 100));
  } finally {
    process.off('unhandledRejection', onRejection);
  }

  assert.deepEqual(rejections, [], 'a dead interaction is a non-event, not a crash');
});

test('an unknown command tells the user rather than failing silently', async () => {
  const interaction = {
    type: 2,
    commandName: 'command-from-an-older-build',
    guild: fakeGuild(),
    guildId: GUILD,
    user: { id: USER, tag: 'curious#0001' },
    replied: false,
    deferred: false,
    sent: [],
    isButton: () => false,
    isChatInputCommand: () => true,
    isRepliable: () => true,
    async reply(payload) {
      interaction.replied = true;
      interaction.sent.push(payload);
    },
    async followUp(payload) {
      interaction.sent.push(payload);
    },
    async editReply(payload) {
      interaction.sent.push(payload);
    }
  };

  bot.getClient().emit(Events.InteractionCreate, interaction);
  await waitFor(() => interaction.sent.length, 'a reply to the unknown command');

  assert.equal(interaction.sent[0].flags, EPHEMERAL);
  assert.match(interaction.sent[0].content, /no longer available/);
});
