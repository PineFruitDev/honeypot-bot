import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessageType } from 'discord.js';
import { Bot } from '../dist/core/Bot.js';
import { EnforcementService } from '../dist/services/EnforcementService.js';
import { GuildConfigStore } from '../dist/services/GuildConfigStore.js';
import { Logger } from '../dist/services/Logger.js';

const GUILD = '111111111111111111';
const USER = '222222222222222222';
let dir, bot, store, events, logs;

function message(overrides = {}) {
  return {
    id: 'message', guildId: GUILD, channelId: 'trap', type: MessageType.Default,
    guild: { id: GUILD }, author: { id: USER }, member: { id: USER }, webhookId: null,
    delete: async () => { events.push('delete'); },
    get content() { throw new Error('Detection must not inspect content'); },
    ...overrides
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'honeypot-message-'));
  GuildConfigStore.instance = null;
  store = await GuildConfigStore.init(dir);
  await store.setTrap(GUILD, { channelId: 'trap', messageId: 'warning', action: 'ban' });
  bot = new Bot('placeholder-not-a-credential');
  bot.acceptingEvents = true;
  events = [];
  logs = [];
  bot.logger = new Logger({ level: 'debug', sink: (_level, line) => logs.push(line) });
  mock.method(globalThis, 'fetch', async () => { assert.fail('Unexpected network request'); });
  mock.method(EnforcementService, 'isExempt', async () => false);
  mock.method(EnforcementService, 'handleCatch', async () => { events.push('catch'); });
  mock.method(EnforcementService, 'refreshTrap', async () => { events.push('refresh'); });
});

afterEach(async () => {
  await bot.stop();
  const requests = globalThis.fetch.mock.callCount();
  mock.restoreAll();
  GuildConfigStore.instance = null;
  await fs.rm(dir, { recursive: true, force: true });
  assert.equal(requests, 0, 'message handling uses mocked enforcement only');
});

test('a detected post is deleted, enforced, and refreshed in order with one correlation ID', async () => {
  const post = message();
  await bot.handleMessage(post);
  assert.deepEqual(events, ['delete', 'catch', 'refresh']);
  const options = EnforcementService.handleCatch.mock.calls[0].arguments[0];
  assert.equal(options.guild, post.guild);
  assert.equal(options.user, post.author);
  assert.equal(options.member, post.member);
  assert.equal(options.source, 'message');
  assert.match(options.correlationId, /^[0-9a-f]{10}$/);
});

test('failed spam deletion still enforces and refreshes the warning', async () => {
  await bot.handleMessage(message({ delete: async () => { throw new Error('Missing Permissions'); } }));
  assert.deepEqual(events, ['catch', 'refresh']);
});

test('a webhook post is deleted without member lookup, enforcement, or refresh', async () => {
  await bot.handleMessage(message({ webhookId: 'webhook' }));
  assert.deepEqual(events, ['delete']);
  assert.equal(EnforcementService.isExempt.mock.callCount(), 0);
  assert.ok(logs.some(line => line.includes('posted-by-a-webhook')));
});

test('failed webhook deletion resolves and releases admission', async () => {
  const release = mock.fn();
  mock.method(bot.guard, 'acquire', () => release);
  await bot.handleMessage(message({ webhookId: 'webhook', delete: async () => { throw new Error('gone'); } }));
  assert.deepEqual(events, []);
  assert.equal(release.mock.callCount(), 1);
});

for (const [label, overrides] of [
  ['member notice', { type: MessageType.UserJoin }],
  ['uncached guild', { guild: null }],
  ['protected channel', { guild: { id: GUILD, systemChannelId: 'trap' } }],
  ['another channel', { channelId: 'general' }],
  ['direct message', { guildId: null, guild: null }]
]) {
  test(`${label} never deletes or enforces`, async () => {
    await bot.handleMessage(message(overrides));
    assert.deepEqual(events, []);
    assert.equal(EnforcementService.isExempt.mock.callCount(), 0);
  });
}

test('an unarmed trap and an exempt member both keep their message', async () => {
  await store.patchGuild(GUILD, { messageId: undefined });
  await bot.handleMessage(message());
  assert.deepEqual(events, []);
  assert.equal(EnforcementService.isExempt.mock.callCount(), 0);

  await store.patchGuild(GUILD, { messageId: 'warning' });
  // Use a fresh guard so the first refused post's cooldown is not what protects this one.
  mock.method(bot.guard, 'acquire', () => () => {});
  mock.method(EnforcementService, 'isExempt', async () => true);
  await bot.handleMessage(message({ id: 'exempt' }));
  assert.deepEqual(events, []);
  assert.equal(EnforcementService.isExempt.mock.callCount(), 1);
});

test('duplicate events cannot enforce twice', async () => {
  await bot.handleMessage(message());
  await bot.handleMessage(message());
  assert.deepEqual(events, ['delete', 'catch', 'refresh']);
});

test('enforcement rejection is logged with its correlation ID and releases admission', async () => {
  const release = mock.fn();
  mock.method(bot.guard, 'acquire', () => release);
  mock.method(EnforcementService, 'handleCatch', async () => { throw new Error('fixture enforcement failure'); });
  await bot.handleMessage(message());
  assert.deepEqual(events, ['delete']);
  assert.equal(release.mock.callCount(), 1);
  const { correlationId } = EnforcementService.handleCatch.mock.calls[0].arguments[0];
  assert.ok(logs.some(line => line.includes(correlationId) && line.includes('fixture enforcement failure')));
});

test('a failed warning refresh does not retry an already completed catch', async () => {
  const release = mock.fn();
  mock.method(bot.guard, 'acquire', () => release);
  mock.method(EnforcementService, 'refreshTrap', async () => { throw new Error('fixture refresh failure'); });
  await bot.handleMessage(message());
  assert.deepEqual(events, ['delete', 'catch']);
  assert.equal(EnforcementService.handleCatch.mock.callCount(), 1);
  assert.equal(release.mock.callCount(), 1);
  assert.ok(logs.some(line => line.includes('fixture refresh failure')));
});
