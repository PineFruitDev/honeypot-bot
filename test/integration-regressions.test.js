import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PendingActionStore } from '../dist/services/PendingActionStore.js';
import { GuildConfigStore } from '../dist/services/GuildConfigStore.js';
import { EnforcementService } from '../dist/services/EnforcementService.js';
import { DiscordApi } from '../dist/services/DiscordApi.js';
import { Logger, serializeError } from '../dist/services/Logger.js';
import { CommandRegistrar } from '../dist/services/CommandRegistrar.js';
import { HoneypotService } from '../dist/services/HoneypotService.js';
import { Bot } from '../dist/core/Bot.js';
import { HoneypotCommand } from '../dist/commands/HoneypotCommand.js';

const guild = { id: '111111111111111111', channels: { cache: new Map() } };
const user = { id: '333333333333333333', tag: 'fixture' };
const log = new Logger({ sink: () => {} });
const originals = Object.fromEntries(['isMemberBanned', 'banReason', 'banMember', 'softbanUnban'].map(k => [k, DiscordApi[k]]));
let dir;
let bans;
let unbans;
let reason;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'honeypot-integration-'));
  PendingActionStore.instance = null;
  GuildConfigStore.instance = null;
  bans = 0; unbans = 0; reason = '';
  DiscordApi.isMemberBanned = async () => false;
  DiscordApi.banMember = async (_g, _u, value) => { bans++; reason = value; return 'success'; };
  DiscordApi.softbanUnban = async () => { unbans++; return { unbanFailed: false, banState: 'lifted', detail: 'ok' }; };
  DiscordApi.banReason = async () => reason;
});
afterEach(async () => {
  Object.assign(DiscordApi, originals);
  await PendingActionStore.getInstance()?.flush();
  PendingActionStore.instance = null;
  GuildConfigStore.instance = null;
  await fs.rm(dir, { recursive: true, force: true });
});
const run = () => EnforcementService.runSoftban({ guild, user, reason: 'test', log });
const pending = () => PendingActionStore.getInstance();

test('a softban is refused without a recovery journal', async () => {
  assert.equal((await run()).result, 'error');
  assert.equal(bans, 0);
});
test('failed journal writes prevent the ban and roll memory back', async () => {
  const journal = await PendingActionStore.init(dir);
  await fs.writeFile(path.join(dir, 'blocked'), 'file');
  journal.filePath = path.join(dir, 'blocked', 'pending.json');
  assert.equal((await run()).result, 'error');
  assert.equal(bans, 0);
  assert.deepEqual(journal.list(), []);
});
test('a transport failure retains recovery intent across restart', async () => {
  await PendingActionStore.init(dir);
  DiscordApi.banMember = async () => 'error';
  const outcome = await run();
  assert.equal(outcome.banState, 'unknown');
  PendingActionStore.instance = null;
  const reopened = await PendingActionStore.init(dir);
  assert.equal(reopened.list()[0].phase, 'unresolved');
});
test('a known existing ban is never overwritten by a softban', async () => {
  await PendingActionStore.init(dir);
  DiscordApi.isMemberBanned = async () => true;
  await run();
  assert.equal(bans, 0);
  assert.equal(unbans, 0);
  assert.deepEqual(pending().list(), []);
});
test('recovery leaves a later staff ban intact', async () => {
  const journal = await PendingActionStore.init(dir);
  await journal.open({ guildId: guild.id, userId: user.id, userTag: user.tag });
  DiscordApi.isMemberBanned = async () => true;
  reason = 'Moderator ban for another incident';
  await EnforcementService.recoverPendingSoftbans(guild);
  assert.equal(unbans, 0);
  assert.equal(journal.list().length, 1);
  assert.match(journal.list()[0].detail, /cannot be attributed/);
});
test('recovery unbans only a ban with this journal entry marker', async () => {
  const journal = await PendingActionStore.init(dir);
  const entry = await journal.open({ guildId: guild.id, userId: user.id, userTag: user.tag });
  DiscordApi.isMemberBanned = async () => true;
  reason = `[honeypot:${entry.id}] test softban`;
  await EnforcementService.recoverPendingSoftbans(guild);
  assert.equal(unbans, 1);
  assert.deepEqual(journal.list(), []);
});
test('a long server retry deadline survives restart and prevents early recovery', async () => {
  await PendingActionStore.init(dir);
  const retryAt = Date.now() + 60_000;
  DiscordApi.softbanUnban = async () => ({ unbanFailed: true, banState: 'unknown', detail: '429', retryAt });
  await run();
  PendingActionStore.instance = null;
  await PendingActionStore.init(dir);
  let checks = 0;
  DiscordApi.isMemberBanned = async () => { checks++; return true; };
  await EnforcementService.recoverPendingSoftbans(guild);
  assert.equal(checks, 0);
  assert.equal(pending().list()[0].retryAt, retryAt);
});
test('an unreadable journal stays blocked across restarts and is not overwritten', async () => {
  const filename = path.join(dir, 'pending-actions.json');
  await fs.writeFile(filename, '{bad');
  await PendingActionStore.init(dir);
  await run();
  PendingActionStore.instance = null;
  const journal = await PendingActionStore.init(dir);
  assert.equal(journal.degraded, true);
  await run();
  assert.equal(bans, 0);
  assert.equal(await fs.readFile(filename, 'utf8'), '{bad');
});
test('unsupported journal versions block mutation', async () => {
  await fs.writeFile(path.join(dir, 'pending-actions.json'), '{"version":99,"pending":[]}');
  const journal = await PendingActionStore.init(dir);
  assert.equal(journal.degraded, true);
  const entry = await journal.open({ guildId: guild.id, userId: user.id, userTag: user.tag });
  assert.equal(entry.persisted, false);
});
test('journal records are snapshots and failed resolutions preserve recovery evidence', async () => {
  const journal = await PendingActionStore.init(dir);
  const entry = await journal.open({ guildId: guild.id, userId: user.id, userTag: user.tag });
  journal.list()[0].phase = 'tampered';
  assert.equal(journal.list()[0].phase, 'ban_pending');
  await fs.writeFile(path.join(dir, 'blocked'), 'file');
  journal.filePath = path.join(dir, 'blocked', 'pending.json');
  await journal.resolve(entry.id);
  assert.equal(journal.list()[0].id, entry.id);
});
test('cyclic error causes are bounded and child fields redact credentials', () => {
  const a = new Error('a'); const b = new Error('b'); a.cause = b; b.cause = a;
  assert.doesNotThrow(() => serializeError(a));
  const lines = [];
  new Logger({ sink: (_level, line) => lines.push(line) }).child({ detail: 'Authorization: Bot abc.def' }).info('failure');
  assert.ok(!lines[0].includes('abc.def'));
});
test('registration refuses conflicting dry-run actions before config or network', () => {
  for (const args of [['--dry-run', '--clear'], ['--rollback', '--dry-run'], ['--guild', 'bad']]) {
    const result = spawnSync(process.execPath, ['dist/register.js', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
  }
});
test('rollback never sends a previous application payload to another application', async () => {
  const calls = [];
  const api = { put: async (target, body) => calls.push(body) };
  const command = name => ({ getRegistrationData: () => ({ name }), getName: () => name, getDescription: () => '', getHelpInfo: () => ({ category: 'test' }) });
  const registrar = (id, name) => new CommandRegistrar([command(name)], { clientId: id, dataDir: dir, target: { scope: 'global' }, api });
  await registrar('app-a', 'first').register();
  await registrar('app-a', 'second').register();
  assert.equal(await registrar('app-b', 'third').rollback(), null);
  await registrar('app-b', 'third').register();
  assert.equal(await registrar('app-b', 'third').rollback(), null);
  assert.equal(calls.length, 3);
});
test('clear retains a rollback point for the same application', async () => {
  const calls = [];
  const command = { getRegistrationData: () => ({ name: 'ping' }), getName: () => 'ping', getDescription: () => '', getHelpInfo: () => ({ category: 'test' }) };
  const registrar = new CommandRegistrar([command], { clientId: 'app', dataDir: dir, target: { scope: 'global' }, api: { put: async (_target, body) => calls.push(body) } });
  await registrar.register(); await registrar.clear(); await registrar.rollback();
  assert.deepEqual(calls, [[{ name: 'ping' }], [], [{ name: 'ping' }]]);
});
test('channel conversion refuses to arm when history cannot be read', async () => {
  const refusal = await new HoneypotCommand().refuseUnsafeConversion({ id: guild.id }, {
    id: 'not-protected', messages: { fetch: async () => { throw new Error('Missing access'); } }
  });
  assert.match(refusal, /could not verify/);
});

test('failed warning refresh preserves the previous warning and binding', async () => {
  const store = await GuildConfigStore.init(dir);
  await store.setTrap(guild.id, { channelId: 'trap', messageId: 'old-warning', action: 'kick' });
  let deletions = 0;
  const channel = { id: 'trap', type: 0, send: async () => { throw new Error('no send'); }, messages: { delete: async () => { deletions++; } } };
  await HoneypotService.refreshSticky({ ...guild, channels: { cache: new Map([['trap', channel]]) } });
  assert.equal(deletions, 0);
  assert.equal(store.getGuild(guild.id).messageId, 'old-warning');
});
test('setup never arms a trap if posting its warning failed', async () => {
  const store = await GuildConfigStore.init(dir);
  const channel = { id: 'trap', type: 0, send: async () => { throw new Error('no send'); } };
  const result = await HoneypotService.deployNew({ ...guild, roles: { everyone: { id: 'everyone' } }, channels: { create: async () => channel } }, { id: 'hide' }, 'trap', 'kick');
  assert.equal(result.ok, false);
  assert.equal(store.getGuild(guild.id), undefined);
});
test('a matching hide-role name never authorizes handing out that existing role', async () => {
  let created = 0;
  const role = await HoneypotService.ensureHideRole({ id: guild.id, roles: {
    cache: { find: () => ({ id: 'admin-role', name: 'Hide Honeypot' }) },
    create: async () => { created++; return { id: 'owned-role' }; }
  } });
  assert.equal(role.id, 'owned-role');
  assert.equal(created, 1);
});
test('safety-alert channels cannot become traps', () => {
  assert.equal(HoneypotService.isProtectedChannel({ safetyAlertsChannelId: 'alerts' }, 'alerts'), true);
});
test('startup does not enforce before recovery has completed', async () => {
  const bot = new Bot('unused');
  let deleted = 0;
  await bot.handleMessage({ delete: async () => { deleted++; } });
  assert.equal(deleted, 0);
  await bot.stop();
});
