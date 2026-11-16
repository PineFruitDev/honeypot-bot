import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChannelType, Collection, PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import { EnforcementService } from '../dist/services/EnforcementService.js';
import { DiscordApi } from '../dist/services/DiscordApi.js';
import { GuildConfigStore } from '../dist/services/GuildConfigStore.js';
import { Logger } from '../dist/services/Logger.js';

const GUILD = '111111111111111111';
const USER = '222222222222222222'; // An established account, never escalated.
let dir, store, guild, user, member, role, channel, effects, reports, logs, originalLogger;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'honeypot-enforcement-'));
  GuildConfigStore.instance = null;
  store = await GuildConfigStore.init(dir);
  await store.setTrap(GUILD, { channelId: 'trap', messageId: 'warning', action: 'timeout' });
  await store.patchGuild(GUILD, { logChannelId: 'logs' });
  effects = [];
  reports = [];
  logs = [];
  originalLogger = EnforcementService.logger;
  EnforcementService.logger = new Logger({ level: 'debug', sink: (_level, line) => logs.push(line) });
  mock.method(globalThis, 'fetch', async () => { assert.fail('Unexpected network request'); });
  mock.method(DiscordApi, 'banMember', async () => { effects.push('ban'); return 'success'; });
  role = { id: 'quarantine', name: 'Quarantined', position: 1, managed: false, permissions: new PermissionsBitField() };
  channel = {
    id: 'logs', type: ChannelType.GuildText,
    permissionOverwrites: { edit: async () => { effects.push('lock'); } },
    permissionsFor: () => new PermissionsBitField(),
    send: async payload => { reports.push(payload.embeds[0].toJSON()); }
  };
  user = {
    id: USER, tag: 'fixture-user', displayAvatarURL: () => 'https://example.invalid/avatar.png',
    send: async () => { effects.push('dm'); }
  };
  member = {
    id: USER,
    roles: {
      highest: { position: 2 }, cache: new Collection(),
      add: async () => { effects.push('assign'); return member; }
    },
    timeout: async (duration, reason) => { effects.push({ duration, reason }); }
  };
  guild = {
    id: GUILD, name: 'Fixture server', ownerId: 'owner', client: { user: { id: 'self' } },
    members: {
      me: { id: 'self', roles: { highest: { position: 10 } }, permissions: new PermissionsBitField([P.BanMembers, P.ModerateMembers, P.ManageRoles]) },
      fetch: async () => member
    },
    roles: {
      cache: new Collection(),
      create: async () => { effects.push('create'); return role; }
    },
    channels: { cache: new Collection([[channel.id, channel]]) }
  };
});

afterEach(async () => {
  mock.restoreAll();
  EnforcementService.logger = originalLogger;
  await store.flush();
  GuildConfigStore.instance = null;
  await fs.rm(dir, { recursive: true, force: true });
});

const run = () => EnforcementService.handleCatch({ guild, user, member, trigger: 'fixture post', source: 'message', correlationId: 'fixture-ref' });
const recordedAction = () => store.getRecentCatches(GUILD)[0]?.action;

test('a timeout applies exactly seven days before recording, DMing, and reporting', async () => {
  const result = await run();
  assert.equal(result.result, 'success');
  assert.equal(result.action, 'timeout');
  assert.equal(recordedAction(), 'timeout');
  assert.equal(effects[0].duration, 7 * 24 * 60 * 60 * 1000);
  assert.match(effects[0].reason, /Automatic timeout/);
  assert.equal(effects[1], 'dm');
  assert.equal(reports.length, 1);
  assert.equal(DiscordApi.banMember.mock.callCount(), 0);
});

for (const [label, error, expected] of [
  ['permission error', { code: 50013 }, 'missing_perms'],
  ['API error', Object.assign(new Error('Unknown Member'), { code: 10007 }), 'error'],
  ['null rejection', null, 'error'],
  ['string rejection', 'offline', 'error'],
  ['string error code', { code: '50013' }, 'error']
]) {
  for (const action of ['timeout', 'quarantine']) {
    test(`${action} handles a ${label} without recording success or sending a DM`, async () => {
      await store.patchGuild(GUILD, { action, quarantineRoleId: role.id });
      guild.roles.cache.set(role.id, role);
      if (action === 'timeout') member.timeout = async () => { throw error; };
      else member.roles.add = async () => { throw error; };
      const outcome = await run();
      assert.equal(outcome.result, expected);
      assert.equal(outcome.action, 'none');
      assert.equal(recordedAction(), 'none');
      assert.ok(!effects.includes('dm'));
      assert.equal(reports.length, 1);
      assert.ok(logs.some(line => line.includes(`${action}Member - Failed`)));
    });
  }
}

for (const action of ['timeout', 'quarantine']) {
  test(`${action} with no resolvable member reports failure without any member action`, async () => {
    await store.patchGuild(GUILD, { action });
    member = null;
    const outcome = await run();
    assert.equal(outcome.result, 'error');
    assert.equal(recordedAction(), 'none');
    assert.deepEqual(effects, []);
    assert.equal(reports.length, 1);
  });
}

test('quarantine creates, locks, saves, and assigns its own role before confirming containment', async () => {
  await store.patchGuild(GUILD, { action: 'quarantine' });
  const create = mock.method(guild.roles, 'create');
  const lock = mock.method(channel.permissionOverwrites, 'edit');
  const permissions = mock.method(channel, 'permissionsFor');
  const result = await run();
  assert.equal(result.result, 'success');
  assert.equal(recordedAction(), 'quarantine');
  assert.equal(store.getGuild(GUILD).quarantineRoleId, role.id);
  assert.deepEqual(effects, ['create', 'lock', 'assign', 'dm']);
  assert.deepEqual(create.mock.calls[0].arguments[0].permissions, []);
  assert.deepEqual(lock.mock.calls[0].arguments.slice(0, 2), [role, { ViewChannel: false, SendMessages: false }]);
  assert.equal(permissions.mock.calls[0].arguments[0], member);
});

for (const [label, effective] of [
  ['visible channels', new PermissionsBitField(P.ViewChannel)],
  ['unreadable channel permissions', null]
]) {
  test(`quarantine never claims containment with ${label}`, async () => {
    await store.patchGuild(GUILD, { action: 'quarantine', quarantineRoleId: role.id });
    guild.roles.cache.set(role.id, role);
    channel.permissionsFor = () => effective;
    // Failed lockdown must still be checked against actual effective permissions.
    channel.permissionOverwrites.edit = async () => { throw new Error('Missing Access'); };
    const result = await run();
    assert.equal(result.result, 'error');
    assert.equal(recordedAction(), 'none');
    assert.deepEqual(effects, ['assign']);
    assert.ok(logs.some(line => line.includes('channels remain accessible')));
  });
}

test('quarantine with an empty channel cache cannot establish containment', async () => {
  await store.patchGuild(GUILD, { action: 'quarantine', quarantineRoleId: role.id });
  guild.roles.cache.set(role.id, role);
  guild.channels.cache.clear();
  assert.equal((await run()).result, 'error');
  assert.equal(recordedAction(), 'none');
  assert.deepEqual(effects, ['assign']);
});

for (const reason of ['managed', 'privileged', 'above bot']) {
  test(`a known quarantine role that is ${reason} is never assigned`, async () => {
    await store.patchGuild(GUILD, { action: 'quarantine', quarantineRoleId: role.id });
    if (reason === 'managed') role.managed = true;
    if (reason === 'privileged') role.permissions = new PermissionsBitField(P.Administrator);
    if (reason === 'above bot') role.position = 11;
    guild.roles.cache.set(role.id, role);
    assert.equal((await run()).result, 'missing_perms');
    assert.equal(recordedAction(), 'none');
    assert.ok(!effects.includes('assign'));
    assert.ok(!effects.includes('create'));
    assert.ok(!effects.includes('dm'));
  });
}

test('failed quarantine role creation remains a reported failure', async () => {
  await store.patchGuild(GUILD, { action: 'quarantine' });
  guild.roles.create = async () => { throw new Error('Missing Permissions'); };
  assert.equal((await run()).result, 'missing_perms');
  assert.equal(store.getGuild(GUILD).quarantineRoleId, undefined);
  assert.equal(recordedAction(), 'none');
  assert.deepEqual(effects, []);
});

for (const [action, permission] of [['ban', P.BanMembers], ['kick', P.BanMembers], ['timeout', P.ModerateMembers], ['quarantine', P.ManageRoles]]) {
  test(`${action} is refused before acting when its permission is missing`, async () => {
    await store.patchGuild(GUILD, { action });
    guild.members.me.permissions.remove(permission);
    const result = await run();
    assert.equal(result.result, 'missing_perms');
    assert.match(result.blockedReason, /permission/);
    assert.equal(recordedAction(), 'none');
    assert.deepEqual(effects, []);
    assert.equal(reports.length, 1);
  });
}

test('an equal member role blocks a ban before it reaches Discord', async () => {
  await store.patchGuild(GUILD, { action: 'ban' });
  member.roles.highest.position = 10;
  const result = await run();
  assert.match(result.blockedReason, /at or above mine/);
  assert.equal(recordedAction(), 'none');
  assert.deepEqual(effects, []);
});

test('failed member lookup cannot bypass configured role exemptions', async () => {
  await store.patchGuild(GUILD, { action: 'ban', exemptRoleIds: ['protected'] });
  member = null;
  guild.members.fetch = async () => { throw new Error('Missing Access'); };
  assert.equal((await run()).skipped, true);
  assert.equal(store.getCatchTotal(GUILD), 0);
  assert.deepEqual(effects, []);
  assert.deepEqual(reports, []);
});

test('history, DM, and report failures cannot turn a completed ban into a failed action', async () => {
  await store.patchGuild(GUILD, { action: 'ban' });
  mock.method(store, 'recordCatch', async () => { throw new Error('fixture disk failure'); });
  user.send = async () => { throw new Error('closed DMs'); };
  channel.send = async () => { throw new Error('fixture report failure'); };
  const result = await run();
  assert.equal(result.action, 'ban');
  assert.equal(result.result, 'success');
  assert.deepEqual(effects, ['ban']);
  assert.equal(store.getCatchTotal(GUILD), 0);
  assert.ok(logs.some(line => line.includes('fixture disk failure')));
  assert.ok(logs.some(line => line.includes('fixture report failure')));
});

test('a thrown ban adapter becomes a failed report and no success DM', async () => {
  await store.patchGuild(GUILD, { action: 'ban' });
  mock.method(DiscordApi, 'banMember', async () => { throw new Error('fixture ban failure'); });
  assert.equal((await run()).result, 'error');
  assert.equal(recordedAction(), 'none');
  assert.deepEqual(effects, []);
  assert.equal(reports.length, 1);
});

test('an unserializable rejection still reaches the catch record and staff report', async () => {
  member.timeout = async () => {
    throw { toJSON() { throw new Error('private fixture payload'); } };
  };
  const outcome = await run();
  assert.equal(outcome.result, 'error');
  assert.equal(recordedAction(), 'none');
  assert.equal(reports.length, 1);
  assert.deepEqual(effects, []);
  assert.ok(logs.some(line => line.includes('timeoutMember - Failed')));
  assert.ok(logs.every(line => !line.includes('private fixture payload')));
});

test('unserializable history failure cannot prevent reporting an already completed ban', async () => {
  await store.patchGuild(GUILD, { action: 'ban' });
  mock.method(store, 'recordCatch', async () => {
    throw { toJSON() { throw new Error('private fixture payload'); } };
  });
  const outcome = await run();
  assert.equal(outcome.result, 'success');
  assert.equal(outcome.action, 'ban');
  assert.deepEqual(effects, ['ban', 'dm']);
  assert.equal(reports.length, 1);
  assert.ok(logs.some(line => line.includes('catch history could not be saved')));
  assert.ok(logs.every(line => !line.includes('private fixture payload')));
});

test('staff alerts skip non-text channels and absorb send failures', async () => {
  channel.type = ChannelType.GuildVoice;
  await EnforcementService.alertStaff(guild, { title: 'Test', description: 'Fixture' });
  assert.deepEqual(reports, []);
  channel.type = ChannelType.GuildText;
  channel.send = async () => { throw new Error('fixture alert failure'); };
  await EnforcementService.alertStaff(guild, { title: 'Test', description: 'Fixture' });
  assert.ok(logs.some(line => line.includes('fixture alert failure')));
});
