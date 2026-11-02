// Tests for what happens once the trap has been tripped: who is spared, which action runs,
// and what gets recorded.
//
// Detection decides that a message counts (see detection.test.js). This is the other half:
// every route into a catch goes through EnforcementService.handleCatch, so the exemptions
// and the escalation rule are asserted here rather than at each call site.
//
// Driven through a stubbed global fetch, so the ban and unban calls are observed without
// touching Discord.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { EnforcementService } from '../dist/services/EnforcementService.js';
import { PendingActionStore } from '../dist/services/PendingActionStore.js';
import { GuildConfigStore } from '../dist/services/GuildConfigStore.js';

const GUILD = '111111111111111111';
const TRAP_CHANNEL = 'trap-1';
const LOG_CHANNEL = 'log-1';
const SELF = '222222222222222222';
const OWNER = '333333333333333333';
const EXEMPT_ROLE = 'moderator-role';

const DISCORD_EPOCH = 1420070400000;
const DAY_MS = 24 * 60 * 60 * 1000;

const realFetch = globalThis.fetch;
let dataDir;
let calls;
let dms;
let memberFetches;
let reports;

/** A user ID whose snowflake says the account was created this many days ago. */
function accountAgedDays(days) {
  return String((BigInt(Date.now() - days * DAY_MS - DISCORD_EPOCH) << 22n) | 7n);
}

const ESTABLISHED = accountAgedDays(400);
const THROWAWAY = accountAgedDays(2);

function createUser(id) {
  return {
    id,
    tag: `offender#${id.slice(-4)}`,
    send: async () => {
      dms.push(id);
    },
    displayAvatarURL: () => 'https://example.invalid/avatar.png'
  };
}

/** A stand-in for the slice of GuildMember that enforcement touches. */
function createMember(id, { roleIds = [], administrator = false } = {}) {
  return {
    id,
    roles: {
      cache: new Collection(roleIds.map(roleId => [roleId, { id: roleId }])),
      add: async () => {}
    },
    permissions: new PermissionsBitField(administrator ? PermissionFlagsBits.Administrator : 0n),
    timeouts: [],
    timeout: async function (ms, reason) {
      this.timeouts.push({ ms, reason });
    }
  };
}

/** A log channel that records what the action report would have said. */
function createLogChannel(id) {
  return {
    id,
    type: ChannelType.GuildText,
    send: async payload => {
      reports.push({ channelId: id, payload });
    }
  };
}

function createGuild({ memberToFetch = null, channels = [] } = {}) {
  return {
    id: GUILD,
    name: 'Test Server',
    ownerId: OWNER,
    client: { user: { id: SELF } },
    roles: { cache: new Collection(), everyone: { id: 'everyone-role' } },
    channels: { cache: new Collection(channels.map(channel => [channel.id, channel])) },
    members: {
      me: null,
      fetch: async id => {
        memberFetches.push(id);
        if (!memberToFetch) throw new Error('Unknown Member');
        return memberToFetch;
      }
    }
  };
}

/** Succeed at every ban and unban, recording each call. */
function stubFetch() {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ method: (init.method ?? 'GET').toUpperCase(), url: String(url), body: init.body });
    return new Response(null, { status: (init.method ?? 'GET') === 'GET' ? 404 : 204 });
  };
}

async function freshStore(config = {}) {
  GuildConfigStore.instance = null;
  const store = await GuildConfigStore.init(dataDir);
  await store.setTrap(GUILD, {
    channelId: TRAP_CHANNEL,
    hideRoleId: 'hide-role',
    createdByBot: true,
    messageId: 'sticky-1',
    action: 'ban'
  });
  if (Object.keys(config).length) await store.patchGuild(GUILD, config);
  return store;
}

const bans = () => calls.filter(call => call.method === 'PUT');
const unbans = () => calls.filter(call => call.method === 'DELETE');

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'honeypot-catch-'));
  calls = [];
  dms = [];
  memberFetches = [];
  reports = [];
  PendingActionStore.instance = null;
  await PendingActionStore.init(dataDir);
  process.env.DISCORD_TOKEN = 'test-token';
  stubFetch();
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  PendingActionStore.instance = null;
  GuildConfigStore.instance = null;
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('the bot is never acted on for its own trap message', async () => {
  const store = await freshStore();
  const self = createUser(SELF);

  const outcome = await EnforcementService.handleCatch({
    guild: createGuild(),
    user: self,
    member: createMember(SELF),
    trigger: 'sent a message in the honeypot channel',
    source: 'message'
  });

  assert.equal(outcome.skipped, true);
  assert.equal(outcome.action, 'none');
  assert.equal(calls.length, 0);
  // An exemption is not a catch, so it must not land in the history or bump the counter.
  assert.equal(store.getCatchTotal(GUILD), 0);
});

test('the server owner is never acted on', async () => {
  // The owner cannot be banned by anyone, so attempting it would fail loudly and file a
  // report about a failure that was never going to succeed.
  await freshStore();

  const outcome = await EnforcementService.handleCatch({
    guild: createGuild(),
    user: createUser(OWNER),
    member: createMember(OWNER),
    trigger: 'pressed a trap button',
    source: 'button',
    requestedAction: 'kick'
  });

  assert.equal(outcome.skipped, true);
  assert.equal(outcome.action, 'none');
  assert.equal(calls.length, 0);
});

test('an exempted user ID is spared and leaves no record', async () => {
  const store = await freshStore({ exemptUserIds: [ESTABLISHED] });

  const outcome = await EnforcementService.handleCatch({
    guild: createGuild(),
    user: createUser(ESTABLISHED),
    member: createMember(ESTABLISHED),
    trigger: 'sent a message in the honeypot channel',
    source: 'message'
  });

  assert.equal(outcome.skipped, true);
  assert.equal(calls.length, 0);
  assert.equal(dms.length, 0);
  assert.equal(store.getCatchTotal(GUILD), 0);
});

test('an exempted role spares the member holding it', async () => {
  await freshStore({ exemptRoleIds: [EXEMPT_ROLE] });

  const outcome = await EnforcementService.handleCatch({
    guild: createGuild(),
    user: createUser(ESTABLISHED),
    member: createMember(ESTABLISHED, { roleIds: [EXEMPT_ROLE] }),
    trigger: 'sent a message in the honeypot channel',
    source: 'message'
  });

  assert.equal(outcome.skipped, true);
  assert.equal(calls.length, 0);
  // The member arrived on the message payload, so no extra fetch was needed for it.
  assert.equal(memberFetches.length, 0);
});

test('an exempted role is still checked when the payload carried no member', async () => {
  // The bot runs without the Server Members intent, so a member object is not guaranteed.
  // Skipping the role check in that case would quietly ban the staff it was told to spare.
  await freshStore({ exemptRoleIds: [EXEMPT_ROLE] });
  const member = createMember(ESTABLISHED, { roleIds: [EXEMPT_ROLE] });

  const outcome = await EnforcementService.handleCatch({
    guild: createGuild({ memberToFetch: member }),
    user: createUser(ESTABLISHED),
    member: null,
    trigger: 'sent a message in the honeypot channel',
    source: 'message'
  });

  assert.deepEqual(memberFetches, [ESTABLISHED]);
  assert.equal(outcome.skipped, true);
  assert.equal(calls.length, 0);
});

test('a member who holds none of the exempted roles is acted on', async () => {
  await freshStore({ exemptRoleIds: [EXEMPT_ROLE] });

  const outcome = await EnforcementService.handleCatch({
    guild: createGuild(),
    user: createUser(ESTABLISHED),
    member: createMember(ESTABLISHED, { roleIds: ['some-other-role'] }),
    trigger: 'sent a message in the honeypot channel',
    source: 'message'
  });

  assert.equal(outcome.skipped, false);
  assert.equal(outcome.action, 'ban');
  assert.equal(bans().length, 1);
});

test('an administrator is not exempt just for being an administrator', async () => {
  // Deliberate, and worth pinning down because it reads as a bug otherwise. Staff are
  // protected by Discord's role hierarchy, which makes an action against someone above the
  // bot fail loudly, and by the explicit exemption lists. Treating the Administrator
  // permission as an exemption would hand every self-granted admin role a free pass.
  await freshStore();

  const outcome = await EnforcementService.handleCatch({
    guild: createGuild(),
    user: createUser(ESTABLISHED),
    member: createMember(ESTABLISHED, { administrator: true }),
    trigger: 'sent a message in the honeypot channel',
    source: 'message'
  });

  assert.equal(outcome.skipped, false);
  assert.equal(outcome.action, 'ban');
});

test('a throwaway account is escalated to a ban even when the guild is set to kick', async () => {
  await freshStore({ action: 'kick' });

  const outcome = await EnforcementService.handleCatch({
    guild: createGuild(),
    user: createUser(THROWAWAY),
    member: createMember(THROWAWAY),
    trigger: 'sent a message in the honeypot channel',
    source: 'message'
  });

  assert.equal(outcome.escalated, true);
  assert.equal(outcome.action, 'ban');
  // A real ban, so nothing is lifted afterwards.
  assert.equal(unbans().length, 0);
  // And the purge is Discord's maximum, so the spam goes from every channel at once.
  assert.deepEqual(JSON.parse(bans()[0].body), { delete_message_seconds: 604800 });
});

test('an established account gets exactly the configured action', async () => {
  await freshStore({ action: 'timeout' });
  const member = createMember(ESTABLISHED);

  const outcome = await EnforcementService.handleCatch({
    guild: createGuild(),
    user: createUser(ESTABLISHED),
    member,
    trigger: 'sent a message in the honeypot channel',
    source: 'message'
  });

  assert.equal(outcome.escalated, false);
  assert.equal(outcome.action, 'timeout');
  assert.equal(member.timeouts.length, 1);
  assert.equal(member.timeouts[0].ms, 7 * DAY_MS);
  // A timeout is not a ban, so the trap must not reach for the ban endpoint at all.
  assert.equal(calls.length, 0);
});

test('the configured kick is carried out as a ban that is then lifted', async () => {
  await freshStore({ action: 'kick' });

  const outcome = await EnforcementService.handleCatch({
    guild: createGuild(),
    user: createUser(ESTABLISHED),
    member: createMember(ESTABLISHED),
    trigger: 'sent a message in the honeypot channel',
    source: 'message'
  });

  assert.equal(outcome.action, 'kick');
  assert.equal(outcome.result, 'success');
  assert.equal(bans().length, 1);
  assert.equal(unbans().length, 1);
});

test('a trap button kicks regardless of the configured action', async () => {
  // The decoy buttons are pressed by curious members far more often than by spam bots, so
  // they are capped at a kick even where the message path is set to ban.
  await freshStore({ action: 'ban' });

  const outcome = await EnforcementService.handleCatch({
    guild: createGuild(),
    user: createUser(ESTABLISHED),
    member: createMember(ESTABLISHED),
    trigger: 'pressed a trap button',
    source: 'button',
    requestedAction: 'kick'
  });

  assert.equal(outcome.action, 'kick');
  assert.equal(unbans().length, 1);
});

test('a guild with no trap configured takes no action', async () => {
  // Reachable while a removal is in flight, and the safe answer is to do nothing rather
  // than fall back to a default action in a server that never asked for one.
  GuildConfigStore.instance = null;
  await GuildConfigStore.init(dataDir);

  const outcome = await EnforcementService.handleCatch({
    guild: createGuild(),
    user: createUser(ESTABLISHED),
    member: createMember(ESTABLISHED),
    trigger: 'sent a message in the honeypot channel',
    source: 'message'
  });

  assert.equal(outcome.skipped, true);
  assert.equal(outcome.action, 'none');
  assert.equal(calls.length, 0);
});

test('a catch is recorded with its source so the stats can tell the paths apart', async () => {
  const store = await freshStore();
  const user = createUser(ESTABLISHED);

  await EnforcementService.handleCatch({
    guild: createGuild(),
    user,
    member: createMember(ESTABLISHED),
    trigger: 'pressed a trap button',
    source: 'button',
    requestedAction: 'kick'
  });

  assert.equal(store.getCatchTotal(GUILD), 1);
  const [recorded] = store.getRecentCatches(GUILD);
  assert.equal(recorded.userId, ESTABLISHED);
  assert.equal(recorded.userTag, user.tag);
  assert.equal(recorded.source, 'button');
  assert.equal(recorded.escalated, false);
});

test('the action report never goes to the trap channel itself', async () => {
  // The trap is readable by everyone, and the report names the offender. Posting it there
  // would turn a moderation record into a public callout.
  await freshStore({ logChannelId: TRAP_CHANNEL });
  const trap = createLogChannel(TRAP_CHANNEL);

  await EnforcementService.handleCatch({
    guild: createGuild({ channels: [trap] }),
    user: createUser(ESTABLISHED),
    member: createMember(ESTABLISHED),
    trigger: 'sent a message in the honeypot channel',
    source: 'message'
  });

  assert.deepEqual(reports, []);
});

test('the action report goes to the configured log channel', async () => {
  await freshStore({ logChannelId: LOG_CHANNEL });
  const log = createLogChannel(LOG_CHANNEL);

  await EnforcementService.handleCatch({
    guild: createGuild({ channels: [createLogChannel(TRAP_CHANNEL), log] }),
    user: createUser(THROWAWAY),
    member: createMember(THROWAWAY),
    trigger: 'sent a message in the honeypot channel',
    source: 'message'
  });

  assert.equal(reports.length, 1);
  assert.equal(reports[0].channelId, LOG_CHANNEL);
});

test('a closed DM never stops the action or the record', async () => {
  // Spam accounts almost always have DMs shut. The courtesy notice is best effort and must
  // not be able to undo enforcement that already landed.
  const store = await freshStore();
  const user = createUser(ESTABLISHED);
  user.send = async () => {
    throw new Error('Cannot send messages to this user');
  };

  const outcome = await EnforcementService.handleCatch({
    guild: createGuild(),
    user,
    member: createMember(ESTABLISHED),
    trigger: 'sent a message in the honeypot channel',
    source: 'message'
  });

  assert.equal(outcome.result, 'success');
  assert.equal(outcome.action, 'ban');
  assert.equal(store.getCatchTotal(GUILD), 1);
});

test('a young account pressing a decoy is softbanned without permanent escalation', async () => {
  await freshStore({ action: 'ban' });
  const outcome = await EnforcementService.handleCatch({ guild: createGuild(), user: createUser(THROWAWAY), member: createMember(THROWAWAY), trigger: 'pressed a trap button', source: 'button', requestedAction: 'kick' });
  assert.equal(outcome.action, 'kick');
  assert.equal(outcome.escalated, false);
  assert.equal(bans().length, 1);
  assert.equal(unbans().length, 1);
});
