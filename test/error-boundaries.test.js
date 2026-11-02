// Tests for the thing that matters once this bot is in more than one server: a failure in
// one guild stays in that guild.
//
// The bot reconciles every configured trap at startup and then registers commands. If one
// server has revoked a permission or deleted a channel, the naive version of that loop
// throws on the first bad guild and the rest are never reconciled, commands are never
// registered, and the failure surfaces as an unhandled rejection in a detached ready
// handler. These tests drive the real loops with one guild rigged to fail.
//
// Discord is never contacted: the client is constructed but never logged in, its guild
// cache is populated by hand, and the two static services the loops call are stubbed.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Bot } from '../dist/core/Bot.js';
import { GuildConfigStore } from '../dist/services/GuildConfigStore.js';
import {
  PendingActionStore,
  MAX_RECOVERY_ATTEMPTS
} from '../dist/services/PendingActionStore.js';
import { HoneypotService } from '../dist/services/HoneypotService.js';
import { EnforcementService } from '../dist/services/EnforcementService.js';
import { DiscordApi } from '../dist/services/DiscordApi.js';

const GUILD_A = '111111111111111111';
const GUILD_B = '222222222222222222';
const USER = '333333333333333333';
const LOG_CHANNEL = 'log-channel';

/** ChannelType.GuildText, hard-coded so the fixtures stay plain data. */
const GUILD_TEXT = 0;

let dataDir;
let bots = [];
const realHideFromRoles = HoneypotService.applyHideFromRoles;
const realRefreshSticky = HoneypotService.refreshSticky;
const realBanReason = DiscordApi.banReason;
const realIsMemberBanned = DiscordApi.isMemberBanned;
const realSoftbanUnban = DiscordApi.softbanUnban;
const realBanMember = DiscordApi.banMember;

/** Collect what gets posted to a guild's log channel. */
function fakeGuild(id, { sent = [], withLogChannel = true } = {}) {
  const channels = new Map([['trap-channel', { id: 'trap-channel', type: GUILD_TEXT }]]);
  if (withLogChannel) {
    channels.set(LOG_CHANNEL, {
      id: LOG_CHANNEL,
      type: GUILD_TEXT,
      send: async payload => {
        sent.push(payload);
      }
    });
  }
  return {
    id,
    name: `Guild ${id}`,
    ownerId: 'owner',
    client: { user: { id: 'bot-user' } },
    channels: { cache: channels },
    roles: { cache: new Map() },
    members: { me: null },
    sent
  };
}

/** A Bot whose client knows about the given fake guilds, and which never logs in. */
function botWith(guilds) {
  const bot = new Bot('unused-token');
  bots.push(bot);
  for (const guild of guilds) bot.getClient().guilds.cache.set(guild.id, guild);
  return bot;
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'honeypot-boundaries-'));
  GuildConfigStore.instance = null;
  PendingActionStore.instance = null;
  await GuildConfigStore.init(dataDir);
  await PendingActionStore.init(dataDir);
  bots = [];
  DiscordApi.isMemberBanned = async () => false;
  DiscordApi.banReason = async (guildId, userId) => {
    const record = PendingActionStore.getInstance().listForGuild(guildId).find(r => r.userId === userId);
    return record ? `[honeypot:${record.id}] test softban` : null;
  };
  HoneypotService.refreshSticky = async () => {};
});

afterEach(async () => {
  for (const bot of bots) await bot.stop().catch(() => {});
  HoneypotService.applyHideFromRoles = realHideFromRoles;
  HoneypotService.refreshSticky = realRefreshSticky;
  DiscordApi.isMemberBanned = realIsMemberBanned;
  DiscordApi.banReason = realBanReason;
  DiscordApi.softbanUnban = realSoftbanUnban;
  DiscordApi.banMember = realBanMember;
  GuildConfigStore.instance = null;
  PendingActionStore.instance = null;
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('one guild failing to reconcile does not stop the others', async () => {
  const store = GuildConfigStore.getInstance();
  await store.setTrap(GUILD_A, { channelId: 'trap-channel', action: 'kick' });
  await store.setTrap(GUILD_B, { channelId: 'trap-channel', action: 'kick' });

  const reconciled = [];
  HoneypotService.applyHideFromRoles = async guild => {
    if (guild.id === GUILD_A) {
      // What a revoked Manage Roles actually looks like from in here.
      throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
    }
    reconciled.push(guild.id);
  };

  const bot = botWith([fakeGuild(GUILD_A), fakeGuild(GUILD_B)]);
  const summary = await bot.reconcileOnBoot();

  assert.deepEqual(reconciled, [GUILD_B], 'the healthy guild was still reconciled');
  assert.equal(summary.total, 2);
  assert.equal(summary.failed, 1, 'the failure is counted, not swallowed');
  // Both traps are still configured: a permission error is not a reason to forget a trap.
  assert.ok(store.getGuild(GUILD_A));
  assert.ok(store.getGuild(GUILD_B));
});

test('reconciliation resolves rather than rejects, so a detached ready handler cannot crash', async () => {
  const store = GuildConfigStore.getInstance();
  await store.setTrap(GUILD_A, { channelId: 'trap-channel', action: 'kick' });
  HoneypotService.applyHideFromRoles = async () => {
    throw new Error('boom');
  };

  const bot = botWith([fakeGuild(GUILD_A)]);

  await assert.doesNotReject(() => bot.reconcileOnBoot());
});

test('a trap whose channel is gone is cleared, and the next guild is still reconciled', async () => {
  const store = GuildConfigStore.getInstance();
  await store.setTrap(GUILD_A, { channelId: 'deleted-channel', action: 'kick' });
  await store.setTrap(GUILD_B, { channelId: 'trap-channel', action: 'kick' });

  const reconciled = [];
  HoneypotService.applyHideFromRoles = async guild => reconciled.push(guild.id);

  const bot = botWith([fakeGuild(GUILD_A), fakeGuild(GUILD_B)]);
  await bot.reconcileOnBoot();

  assert.equal(store.getGuild(GUILD_A), undefined, 'the dead trap was forgotten');
  assert.deepEqual(reconciled, [GUILD_B]);
});

test('a leftover softban is lifted at startup and staff are told', async () => {
  const store = GuildConfigStore.getInstance();
  await store.setTrap(GUILD_A, { channelId: 'trap-channel', action: 'kick' });
  await store.patchGuild(GUILD_A, { logChannelId: LOG_CHANNEL });

  const journal = PendingActionStore.getInstance();
  const entry = await journal.open({ guildId: GUILD_A, userId: USER, userTag: 'spam#0001' });
  await journal.setPhase(entry.id, 'unban_pending');

  DiscordApi.isMemberBanned = async () => true;
  DiscordApi.softbanUnban = async () => ({
    unbanFailed: false,
    banState: 'lifted',
    detail: 'attempt 1/3: success http=204'
  });

  const guild = fakeGuild(GUILD_A);
  const bot = botWith([guild]);
  const result = await bot.recoverPendingActions();

  assert.equal(result.pending, 1);
  assert.deepEqual(journal.list(), [], 'the debt is paid, so the record is gone');
  assert.equal(guild.sent.length, 1, 'staff are told the ban was lifted');
  assert.match(guild.sent[0].embeds[0].data.description, /has now been lifted/);
});

test('a leftover ban nobody can verify is reported as unverified, not as a fact', async () => {
  const store = GuildConfigStore.getInstance();
  await store.setTrap(GUILD_A, { channelId: 'trap-channel', action: 'kick' });
  await store.patchGuild(GUILD_A, { logChannelId: LOG_CHANNEL });

  const journal = PendingActionStore.getInstance();
  const entry = await journal.open({ guildId: GUILD_A, userId: USER, userTag: 'spam#0001' });
  await journal.setPhase(entry.id, 'unban_pending');

  // The ban lookup itself fails: 403, 429 or 5xx all land here.
  DiscordApi.isMemberBanned = async () => null;

  const guild = fakeGuild(GUILD_A);
  const bot = botWith([guild]);
  await bot.recoverPendingActions();

  assert.equal(journal.list().length, 1, 'an unknown outcome keeps the record');
  assert.equal(journal.list()[0].recoveryAttempts, 1);
  assert.match(guild.sent[0].embeds[0].data.description, /not verify/i);
});

test('one guild failing recovery does not stop another guild being recovered', async () => {
  const store = GuildConfigStore.getInstance();
  for (const id of [GUILD_A, GUILD_B]) {
    await store.setTrap(id, { channelId: 'trap-channel', action: 'kick' });
    await store.patchGuild(id, { logChannelId: LOG_CHANNEL });
  }

  const journal = PendingActionStore.getInstance();
  const first = await journal.open({ guildId: GUILD_A, userId: USER, userTag: 'a#1' });
  const second = await journal.open({ guildId: GUILD_B, userId: USER, userTag: 'b#2' });
  await journal.setPhase(first.id, 'unban_pending');
  await journal.setPhase(second.id, 'unban_pending');

  DiscordApi.isMemberBanned = async guildId => {
    if (guildId === GUILD_A) throw new Error('gateway exploded');
    return false; // guild B: no ban remains, nothing was owed
  };

  const bot = botWith([fakeGuild(GUILD_A), fakeGuild(GUILD_B)]);
  await assert.doesNotReject(() => bot.recoverPendingActions());

  const remaining = journal.list();
  assert.equal(remaining.length, 1, 'guild B was resolved despite guild A throwing');
  assert.equal(remaining[0].guildId, GUILD_A, 'and the unrecovered record is kept');
});

test('a record that has used its recovery budget is left alone, not retried forever', async () => {
  const store = GuildConfigStore.getInstance();
  await store.setTrap(GUILD_A, { channelId: 'trap-channel', action: 'kick' });
  await store.patchGuild(GUILD_A, { logChannelId: LOG_CHANNEL });

  const journal = PendingActionStore.getInstance();
  const entry = await journal.open({ guildId: GUILD_A, userId: USER, userTag: 'spam#0001' });
  await journal.setPhase(entry.id, 'unresolved', 'tried everything');
  for (let i = 0; i < MAX_RECOVERY_ATTEMPTS; i++) {
    await journal.noteRecoveryAttempt(entry.id, 'tried everything');
  }

  let looked = 0;
  DiscordApi.isMemberBanned = async () => {
    looked++;
    return true;
  };

  const guild = fakeGuild(GUILD_A);
  const bot = botWith([guild]);
  await bot.recoverPendingActions();

  assert.equal(looked, 0, 'no rate limit budget is spent re-learning the same thing');
  assert.equal(guild.sent.length, 0, 'and staff are not re-alerted on every boot');
  assert.equal(journal.list().length, 1, 'but the record stays: someone is still banned');
});

test('a pending softban for a guild the bot has left is kept, not discarded', async () => {
  const journal = PendingActionStore.getInstance();
  const entry = await journal.open({ guildId: GUILD_B, userId: USER, userTag: 'spam#0001' });
  await journal.setPhase(entry.id, 'unresolved', 'could not unban');

  // The bot is only in guild A now. Deleting the record would erase the only evidence that
  // somebody is still banned in a server it might be re-invited to.
  const bot = botWith([fakeGuild(GUILD_A)]);
  const result = await bot.recoverPendingActions();

  assert.equal(result.guilds, 0, 'nothing could be acted on');
  assert.equal(journal.list().length, 1);
});

test('a failed softban leaves a recoverable record behind', async () => {
  const store = GuildConfigStore.getInstance();
  await store.setTrap(GUILD_A, { channelId: 'trap-channel', action: 'kick' });
  await store.patchGuild(GUILD_A, { logChannelId: LOG_CHANNEL });

  DiscordApi.banMember = async () => 'success';
  DiscordApi.softbanUnban = async () => ({
    unbanFailed: true,
    banState: 'still_banned',
    detail: 'attempt 3/3: error http=500 (ban re-check: member is still banned)'
  });

  const guild = fakeGuild(GUILD_A);
  const outcome = await EnforcementService.handleCatch({
    guild,
    user: establishedUser(),
    member: null,
    trigger: 'sent a message in the honeypot channel',
    source: 'message'
  });

  assert.equal(outcome.banState, 'still_banned');
  const pending = PendingActionStore.getInstance().list();
  assert.equal(pending.length, 1, 'the unban that was owed is on record');
  assert.equal(pending[0].phase, 'unresolved');
  assert.match(pending[0].detail, /http=500/);
  // And the report says it is confirmed rather than guessed.
  const report = guild.sent.at(-1).embeds[0].data;
  assert.ok(report.fields.some(field => /Softban unban failed/.test(field.name)));
});

test('a clean softban leaves no record to recover', async () => {
  const store = GuildConfigStore.getInstance();
  await store.setTrap(GUILD_A, { channelId: 'trap-channel', action: 'kick' });

  DiscordApi.banMember = async () => 'success';
  DiscordApi.softbanUnban = async () => ({
    unbanFailed: false,
    banState: 'lifted',
    detail: 'attempt 1/3: success http=204'
  });

  const outcome = await EnforcementService.handleCatch({
    guild: fakeGuild(GUILD_A, { withLogChannel: false }),
    user: establishedUser(),
    member: null,
    trigger: 'sent a message in the honeypot channel',
    source: 'message'
  });

  assert.equal(outcome.result, 'success');
  assert.deepEqual(PendingActionStore.getInstance().list(), []);
});

test('a ban that never landed leaves no record either', async () => {
  const store = GuildConfigStore.getInstance();
  await store.setTrap(GUILD_A, { channelId: 'trap-channel', action: 'kick' });

  // No Ban Members permission: there is no half finished action, because nothing happened.
  DiscordApi.banMember = async () => 'missing_perms';

  await EnforcementService.handleCatch({
    guild: fakeGuild(GUILD_A, { withLogChannel: false }),
    user: establishedUser(),
    member: null,
    trigger: 'sent a message in the honeypot channel',
    source: 'message'
  });

  assert.deepEqual(
    PendingActionStore.getInstance().list(),
    [],
    'nothing to undo means nothing to journal'
  );
});

test('a catch carries a correlation ID that ties its log lines together', async () => {
  const store = GuildConfigStore.getInstance();
  await store.setTrap(GUILD_A, { channelId: 'trap-channel', action: 'ban' });
  DiscordApi.banMember = async () => 'success';

  const outcome = await EnforcementService.handleCatch({
    guild: fakeGuild(GUILD_A, { withLogChannel: false }),
    user: establishedUser(),
    member: null,
    trigger: 'sent a message in the honeypot channel',
    source: 'message',
    correlationId: 'given-by-caller'
  });

  assert.equal(outcome.correlationId, 'given-by-caller');
});

test('shutdown flushes what is on the way to disk', async () => {
  const store = GuildConfigStore.getInstance();
  await store.setTrap(GUILD_A, { channelId: 'trap-channel', action: 'kick' });

  const journal = PendingActionStore.getInstance();
  const entry = await journal.open({ guildId: GUILD_A, userId: USER, userTag: 'spam#0001' });
  // Not awaited: the write is still queued when the shutdown starts.
  void journal.setPhase(entry.id, 'unban_pending');

  const bot = botWith([fakeGuild(GUILD_A)]);
  await bot.stop();

  const onDisk = JSON.parse(await fs.readFile(path.join(dataDir, 'pending-actions.json'), 'utf-8'));
  assert.equal(onDisk.pending[0].phase, 'unban_pending', 'the queued write landed');
});

test('shutdown is safe to call twice', async () => {
  const bot = botWith([fakeGuild(GUILD_A)]);

  await bot.stop();
  await assert.doesNotReject(() => bot.stop());
});

/** Discord's epoch, for building a snowflake old enough to dodge the escalation rule. */
const DISCORD_EPOCH = 1420070400000;

/**
 * A user whose account is old enough not to be escalated to a ban, so a test about the
 * softban is actually testing the softban.
 */
function establishedUser() {
  const createdMs = Date.now() - 400 * 24 * 60 * 60 * 1000;
  const id = String((BigInt(createdMs - DISCORD_EPOCH) << 22n) | 1n);
  return {
    id,
    tag: 'spam#0001',
    send: async () => {
      throw new Error('cannot DM this user');
    },
    displayAvatarURL: () => 'https://example.invalid/avatar.png'
  };
}
