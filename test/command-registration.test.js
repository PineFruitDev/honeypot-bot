// Tests for slash command registration: that production resolves to global and development
// to a test guild, that a repeat run is a no-op, that the two targets never satisfy each
// other's fingerprint, and that a release can be reviewed, cleared and rolled back.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CommandRegistrar,
  describeTarget,
  resolveRegistrationTarget,
  targetKey
} from '../dist/services/CommandRegistrar.js';

const CLIENT_ID = '222222222222222222';
const OTHER_CLIENT_ID = '999999999999999999';
const DEV_GUILD = '333333333333333333';

const GLOBAL = { scope: 'global' };
const GUILD = { scope: 'guild', guildId: DEV_GUILD };

let dataDir;

/** Duck-typed stand-in for a Command: the registrar only ever asks for these four. */
function fakeCommand(name, description = `does ${name}`, extra = {}) {
  return {
    getRegistrationData: () => ({ name, description, ...extra }),
    getName: () => name,
    getDescription: () => description,
    getHelpInfo: () => ({ name, description, usage: `/${name}`, examples: [], category: 'Test' })
  };
}

/** Records every payload it is handed, and can be told to refuse. */
function fakeApi({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    put: async (target, body) => {
      calls.push({ target, body });
      if (fail) throw new Error('Discord said no');
      return body;
    }
  };
}

function registrar(commands, target, api, { clientId = CLIENT_ID } = {}) {
  return new CommandRegistrar(commands, { clientId, dataDir, target, api });
}

async function readState() {
  return JSON.parse(await fs.readFile(path.join(dataDir, 'commands.json'), 'utf-8'));
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'honeypot-register-'));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('production registers globally and development registers to the dev guild', () => {
  assert.deepEqual(resolveRegistrationTarget({ nodeEnv: 'production' }), GLOBAL);
  assert.deepEqual(
    resolveRegistrationTarget({ nodeEnv: 'production', devGuildId: DEV_GUILD }),
    GLOBAL,
    'a dev guild does not pull production off global'
  );
  assert.deepEqual(resolveRegistrationTarget({ nodeEnv: 'development', devGuildId: DEV_GUILD }), GUILD);
});

test('a non-production environment without a dev guild refuses rather than going global', () => {
  assert.throws(() => resolveRegistrationTarget({ nodeEnv: 'development' }), /DEV_GUILD_ID/);
  assert.throws(() => resolveRegistrationTarget({ nodeEnv: 'staging' }), /DEV_GUILD_ID/);
});

test('registering twice calls Discord once', async () => {
  const commands = [fakeCommand('honeypot'), fakeCommand('ping')];
  const api = fakeApi();

  const first = await registrar(commands, GLOBAL, api).register();
  assert.equal(first.outcome, 'registered');
  assert.equal(first.count, 2);

  // A separate instance, as a second run of the script would be.
  const second = await registrar(commands, GLOBAL, api).register();
  assert.equal(second.outcome, 'unchanged');
  assert.equal(second.hash, first.hash, 'the same command set fingerprints the same');
  assert.equal(api.calls.length, 1);
});

test('--force re-sends an unchanged command set', async () => {
  const commands = [fakeCommand('honeypot')];
  const api = fakeApi();

  await registrar(commands, GLOBAL, api).register();
  const forced = await registrar(commands, GLOBAL, api).register({ force: true });

  assert.equal(forced.outcome, 'registered');
  assert.equal(api.calls.length, 2);
});

test('an edited command re-registers', async () => {
  const api = fakeApi();

  await registrar([fakeCommand('honeypot', 'catches bots')], GLOBAL, api).register();
  const result = await registrar([fakeCommand('honeypot', 'catches bots and scammers')], GLOBAL, api).register();

  assert.equal(result.outcome, 'registered');
  assert.equal(api.calls.length, 2);
});

test('the dev guild fingerprint does not make global look up to date', async () => {
  const commands = [fakeCommand('honeypot')];
  const api = fakeApi();

  const guild = await registrar(commands, GUILD, api).register();
  const global = await registrar(commands, GLOBAL, api).register();

  assert.equal(guild.outcome, 'registered');
  assert.equal(global.outcome, 'registered', 'the same payload still has to be sent to the other target');
  assert.deepEqual(api.calls.map(call => call.target), [GUILD, GLOBAL]);
  assert.notEqual(guild.hash, global.hash, 'the fingerprint is scoped to the target');

  const state = await readState();
  assert.ok(state.targets[targetKey(GUILD)], 'the guild record is kept separately');
  assert.ok(state.targets[targetKey(GLOBAL)]);
  assert.equal(state.targets[targetKey(GUILD)].guildId, DEV_GUILD);
});

test('pointing at another application re-registers rather than trusting the stored hash', async () => {
  const commands = [fakeCommand('honeypot')];
  const api = fakeApi();

  await registrar(commands, GLOBAL, api).register();
  const other = await registrar(commands, GLOBAL, api, { clientId: OTHER_CLIENT_ID }).register();

  assert.equal(other.outcome, 'registered');
  assert.equal(api.calls.length, 2);
});

test('a failed registration leaves the old fingerprint so the next run retries', async () => {
  const commands = [fakeCommand('honeypot')];
  const failing = fakeApi({ fail: true });

  const failed = await registrar(commands, GLOBAL, failing).register();
  assert.equal(failed.outcome, 'failed', 'reported, not thrown');
  assert.ok(failed.error);

  const working = fakeApi();
  const retried = await registrar(commands, GLOBAL, working).register();
  assert.equal(retried.outcome, 'registered');
  assert.equal(working.calls.length, 1);
});

test('plan reports the diff without calling Discord', async () => {
  const api = fakeApi();
  await registrar(
    [fakeCommand('honeypot'), fakeCommand('ping'), fakeCommand('help')],
    GLOBAL,
    api
  ).register();

  const plan = await registrar(
    [fakeCommand('honeypot'), fakeCommand('ping', 'replies with latency'), fakeCommand('stats')],
    GLOBAL,
    api
  ).plan();

  assert.equal(api.calls.length, 1, 'the plan is read-only');
  assert.equal(plan.changed, true);
  assert.equal(plan.baselineUnknown, false);
  assert.deepEqual(plan.added, ['stats']);
  assert.deepEqual(plan.modified, ['ping']);
  assert.deepEqual(plan.removed, ['help'], 'a dropped command is named, because a bulk overwrite drops it');
});

test('plan says so when there is no retained payload to compare against', async () => {
  const plan = await registrar([fakeCommand('honeypot')], GLOBAL, fakeApi()).plan();

  assert.equal(plan.changed, true);
  assert.equal(plan.baselineUnknown, true, 'an empty diff here would read as "nothing changes"');
  assert.equal(plan.previousHash, null);
  assert.deepEqual(plan.added, []);
});

test('plan reports no change when the target already holds the payload', async () => {
  const commands = [fakeCommand('honeypot')];
  const api = fakeApi();

  await registrar(commands, GLOBAL, api).register();
  const plan = await registrar(commands, GLOBAL, api).plan();

  assert.equal(plan.changed, false);
  assert.deepEqual(plan.added, []);
  assert.deepEqual(plan.removed, []);
  assert.deepEqual(plan.modified, []);
});

test('clearing the dev guild sends an empty set and retains rollback', async () => {
  const commands = [fakeCommand('honeypot')];
  const api = fakeApi();

  await registrar(commands, GUILD, api).register();
  const cleared = await registrar(commands, GUILD, api).clear();

  assert.equal(cleared.outcome, 'cleared');
  assert.deepEqual(api.calls.at(-1), { target: GUILD, body: [] });

  const state = await readState();
  assert.deepEqual(state.targets[targetKey(GUILD)].payload, []);

  // And the next registration to that guild is a real call again, not a skip.
  const again = await registrar(commands, GUILD, api).register();
  assert.equal(again.outcome, 'registered');
});

test('clearing one target leaves the other registered', async () => {
  const commands = [fakeCommand('honeypot')];
  const api = fakeApi();

  await registrar(commands, GLOBAL, api).register();
  await registrar(commands, GUILD, api).register();
  await registrar(commands, GUILD, api).clear();

  const state = await readState();
  assert.ok(state.targets[targetKey(GLOBAL)], 'global survives a dev guild cleanup');
  assert.deepEqual(state.targets[targetKey(GUILD)].payload, []);
});

test('rollback re-sends the payload the target held before', async () => {
  const api = fakeApi();
  const before = [fakeCommand('honeypot'), fakeCommand('ping')];
  const after = [fakeCommand('honeypot')];

  await registrar(before, GLOBAL, api).register();
  await registrar(after, GLOBAL, api).register();

  const rolled = await registrar(after, GLOBAL, api).rollback();

  assert.equal(rolled.outcome, 'registered');
  assert.equal(rolled.count, 2);
  assert.deepEqual(
    api.calls.at(-1).body.map(entry => entry.name),
    ['honeypot', 'ping'],
    'the dropped command comes back'
  );

  // The payload that was rolled back out is now the rollback point, so a second
  // rollback returns to where we were rather than walking further back.
  const forward = await registrar(after, GLOBAL, api).rollback();
  assert.deepEqual(forward.outcome, 'registered');
  assert.deepEqual(api.calls.at(-1).body.map(entry => entry.name), ['honeypot']);
});

test('rollback with nothing retained reports instead of sending an empty set', async () => {
  const api = fakeApi();
  await registrar([fakeCommand('honeypot')], GLOBAL, api).register();

  const rolled = await registrar([fakeCommand('honeypot')], GLOBAL, api).rollback();

  assert.equal(rolled, null);
  assert.equal(api.calls.length, 1, 'a missing rollback point must not clear the commands');
});

test('a registration record from before targets existed is read as the global one', async () => {
  const commands = [fakeCommand('honeypot')];
  const api = fakeApi();

  // The shape the old registrar wrote: one flat global record, no payload retained.
  const legacyHash = (await registrar(commands, GLOBAL, api).plan()).hash;
  await fs.writeFile(
    path.join(dataDir, 'commands.json'),
    JSON.stringify({ hash: legacyHash, clientId: CLIENT_ID, count: 1, registeredAt: '2026-01-01T00:00:00.000Z' }),
    'utf-8'
  );

  const result = await registrar(commands, GLOBAL, api).register();

  assert.equal(result.outcome, 'unchanged', 'an upgrade does not spend a registration re-sending the same set');
  assert.equal(api.calls.length, 0);
});

test('an unreadable registration record is kept aside, not overwritten in place', async () => {
  const statePath = path.join(dataDir, 'commands.json');
  await fs.writeFile(statePath, '{"targets": {"global": ', 'utf-8');

  const api = fakeApi();
  const result = await registrar([fakeCommand('honeypot')], GLOBAL, api).register();

  assert.equal(result.outcome, 'registered', 'a corrupt record means unregistered, not unusable');
  const kept = await fs.readFile(`${statePath}.unreadable`, 'utf-8');
  assert.equal(kept, '{"targets": {"global": ');
});

test('targets describe themselves the way the logs read', () => {
  assert.equal(describeTarget(GLOBAL), 'global');
  assert.equal(describeTarget(GUILD), `guild ${DEV_GUILD}`);
  assert.equal(targetKey(GLOBAL), 'global');
  assert.equal(targetKey(GUILD), `guild:${DEV_GUILD}`);
});
