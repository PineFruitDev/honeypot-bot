// Tests for the journal of half finished actions.
//
// This file exists for one scenario: the bot bans someone as the first half of a softban,
// and then dies before the unban. Without a durable record of the intent, that member is
// permanently banned and nothing in the system knows it owes them anything. So the tests
// below are mostly about what survives a restart, and about the file not being destroyed
// by the very crash it is meant to survive.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PendingActionStore, MAX_RECOVERY_ATTEMPTS } from '../dist/services/PendingActionStore.js';

const GUILD = '111111111111111111';
const OTHER_GUILD = '222222222222222222';
const USER = '333333333333333333';

let dataDir;

/**
 * The store is a process-wide singleton, as it is in the running bot. `instance` is private
 * in TypeScript but a plain property at runtime, and nulling it is the only way to get an
 * isolated journal per test. Same deliberate trick as store.test.js.
 */
async function freshJournal() {
  PendingActionStore.instance = null;
  return PendingActionStore.init(dataDir);
}

const journalPath = () => path.join(dataDir, 'pending-actions.json');

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'honeypot-pending-'));
});

afterEach(async () => {
  PendingActionStore.instance = null;
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('a softban intent is on disk before anything else happens', async () => {
  const journal = await freshJournal();

  const entry = await journal.open({ guildId: GUILD, userId: USER, userTag: 'spam#0001' });

  assert.equal(entry.persisted, true, 'open resolves only once the write landed');
  const onDisk = JSON.parse(await fs.readFile(journalPath(), 'utf-8'));
  assert.equal(onDisk.pending.length, 1);
  assert.equal(onDisk.pending[0].phase, 'ban_pending', 'the intent is recorded before the ban');
  assert.equal(onDisk.pending[0].userId, USER);
});

test('an unresolved softban survives a restart', async () => {
  const journal = await freshJournal();
  const entry = await journal.open({ guildId: GUILD, userId: USER, userTag: 'spam#0001' });
  await journal.setPhase(entry.id, 'unban_pending');

  // The crash: the process goes away owing an unban.
  const reopened = await freshJournal();
  const pending = reopened.listForGuild(GUILD);

  assert.equal(pending.length, 1);
  assert.equal(pending[0].phase, 'unban_pending');
  assert.equal(pending[0].userId, USER);
});

test('a completed softban leaves nothing behind', async () => {
  const journal = await freshJournal();
  const entry = await journal.open({ guildId: GUILD, userId: USER, userTag: 'spam#0001' });
  await journal.setPhase(entry.id, 'unban_pending');
  await journal.resolve(entry.id);

  const reopened = await freshJournal();

  assert.deepEqual(reopened.list(), [], 'a finished action is not a pending one');
});

test('records are scoped per guild', async () => {
  const journal = await freshJournal();
  await journal.open({ guildId: GUILD, userId: USER, userTag: 'a#1' });
  await journal.open({ guildId: OTHER_GUILD, userId: '444444444444444444', userTag: 'b#2' });

  assert.equal(journal.listForGuild(GUILD).length, 1);
  assert.equal(journal.listForGuild(OTHER_GUILD).length, 1);
  assert.equal(journal.list().length, 2);
});

test('the failure detail is kept with the record for staff to read', async () => {
  const journal = await freshJournal();
  const entry = await journal.open({ guildId: GUILD, userId: USER, userTag: 'spam#0001' });

  await journal.setPhase(entry.id, 'unresolved', 'attempt 3/3: error http=500 (still banned)');

  const reopened = await freshJournal();
  assert.match(reopened.list()[0].detail, /http=500/);
  assert.equal(reopened.listUnresolved().length, 1);
});

test('a record stops being retried automatically once the attempt budget is spent', async () => {
  const journal = await freshJournal();
  const entry = await journal.open({ guildId: GUILD, userId: USER, userTag: 'spam#0001' });

  for (let i = 0; i < MAX_RECOVERY_ATTEMPTS; i++) {
    await journal.noteRecoveryAttempt(entry.id, 'still failing');
  }

  // Still listed: giving up on retrying is not the same as forgetting someone is banned.
  assert.equal(journal.list().length, 1);
  assert.equal(journal.listUnresolved().length, 1);
  assert.equal(journal.list()[0].recoveryAttempts, MAX_RECOVERY_ATTEMPTS);
});

test('a write leaves no temp file behind', async () => {
  const journal = await freshJournal();
  await journal.open({ guildId: GUILD, userId: USER, userTag: 'spam#0001' });
  await journal.flush();

  const files = await fs.readdir(dataDir);

  // The write goes temp-file-then-rename, so a crash mid-write leaves the old journal or
  // the new one, never a truncated one. Nothing should be left over afterwards.
  assert.deepEqual(files, ['pending-actions.json']);
});

test('a corrupt journal is set aside rather than overwritten', async () => {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(journalPath(), '{"pending": [', 'utf-8');

  const journal = await freshJournal();

  assert.equal(journal.degraded, true, 'the store knows it cannot be trusted');
  assert.deepEqual(journal.list(), []);
  // The bans the unreadable file described can still be found by hand.
  const copy = await fs.readFile(`${journalPath()}.corrupt`, 'utf-8');
  assert.equal(copy, '{"pending": [');
});

test('a junk record does not stop the sound records from loading', async () => {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    journalPath(),
    JSON.stringify({
      version: 1,
      pending: [
        { nonsense: true },
        {
          id: 'keep-me',
          kind: 'softban',
          guildId: GUILD,
          userId: USER,
          userTag: 'spam#0001',
          phase: 'unban_pending',
          openedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          recoveryAttempts: 0
        }
      ]
    }),
    'utf-8'
  );

  const journal = await freshJournal();

  assert.equal(journal.list().length, 1, 'one bad entry must not hide a real ban');
  assert.equal(journal.list()[0].id, 'keep-me');
});

test('a missing journal is an empty journal, not a degraded one', async () => {
  const journal = await freshJournal();

  assert.deepEqual(journal.list(), []);
  assert.equal(journal.degraded, false, 'nothing was left half done, which is not a failure');
});
