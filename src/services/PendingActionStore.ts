import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Logger } from './Logger.js';

/**
 * A durable journal of moderation actions that are only half done.
 *
 * This exists for exactly one failure mode, which is the worst one this bot has: a softban
 * is a ban followed by an unban, and a crash, redeploy or host restart in between leaves a
 * member permanently banned when a kick was intended. In-memory retries cannot fix that,
 * because the process that owed the unban is gone.
 *
 * So the intent is written to disk *before* the ban, moved through its phases as the action
 * proceeds, and only removed once the member is known to be unbanned. Anything still in the
 * file at startup is work the previous process owed somebody.
 *
 * Writes go through a temp file and a rename, so a crash mid-write leaves either the old
 * journal or the new one, never a half written one. The file is small by construction: a
 * record lives for seconds unless something went wrong.
 */

/** Where a softban got to. */
export type PendingPhase =
  /** The ban has been requested but not confirmed. A crash here may or may not have banned. */
  | 'ban_pending'
  /** The ban landed. The unban is owed. This is the dangerous phase. */
  | 'unban_pending'
  /** Every unban attempt failed, or the outcome could not be determined. Needs a human. */
  | 'unresolved';

export interface PendingAction {
  id: string;
  kind: 'softban';
  guildId: string;
  userId: string;
  userTag: string;
  phase: PendingPhase;
  openedAt: string;
  updatedAt: string;
  /** How many times recovery has tried to finish this, so a dead record stops retrying. */
  recoveryAttempts: number;
  /** Last failure description, already redacted by the caller. */
  detail?: string;
  retryAt?: number;
}

interface JournalShape {
  version: 1;
  pending: PendingAction[];
}

/** Give up automatic recovery after this many boots, and leave it for staff instead. */
export const MAX_RECOVERY_ATTEMPTS = 3;

function isPendingPhase(value: unknown): value is PendingPhase {
  return value === 'ban_pending' || value === 'unban_pending' || value === 'unresolved';
}

/** Only records that are structurally sound are kept: a junk entry must not block recovery. */
function parseRecord(value: unknown): PendingAction | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id) return null;
  if (typeof record.guildId !== 'string' || !record.guildId) return null;
  if (typeof record.userId !== 'string' || !record.userId) return null;
  if (!isPendingPhase(record.phase)) return null;

  const openedAt = typeof record.openedAt === 'string' ? record.openedAt : new Date().toISOString();
  return {
    id: record.id,
    kind: 'softban',
    guildId: record.guildId,
    userId: record.userId,
    userTag: typeof record.userTag === 'string' ? record.userTag : record.userId,
    phase: record.phase,
    openedAt,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : openedAt,
    recoveryAttempts:
      typeof record.recoveryAttempts === 'number' && record.recoveryAttempts >= 0
        ? record.recoveryAttempts
        : 0,
    detail: typeof record.detail === 'string' ? record.detail : undefined,
    retryAt: typeof record.retryAt === 'number' && Number.isFinite(record.retryAt) ? record.retryAt : undefined
  };
}

export class PendingActionStore {
  private static instance: PendingActionStore | null = null;

  private logger = new Logger({ context: 'PendingActionStore' });
  private records = new Map<string, PendingAction>();
  private filePath: string;
  private writeChain: Promise<void> = Promise.resolve();
  /** Set when the journal could not be read, so recovery reports uncertainty honestly. */
  private loadFailed = false;

  private constructor(dataDir: string) {
    this.filePath = path.resolve(dataDir, 'pending-actions.json');
  }

  public static async init(dataDir: string): Promise<PendingActionStore> {
    if (!PendingActionStore.instance) {
      PendingActionStore.instance = new PendingActionStore(dataDir);
      await PendingActionStore.instance.load();
    }
    return PendingActionStore.instance;
  }

  public static getInstance(): PendingActionStore | null {
    return PendingActionStore.instance;
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch (error: unknown) {
      if ((error as { code?: string })?.code === 'ENOENT') {
        this.logger.info('load - No pending action journal, nothing was left half done');
      } else {
        // Unreadable is not the same as empty: say so, and keep the file for a human.
        this.loadFailed = true;
        this.logger.error('load - Could not read the pending action journal', error, {
          action: 'journal_load'
        });
      }
      return;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<JournalShape>;
      if (parsed?.version !== 1 || !Array.isArray(parsed.pending)) throw new Error('Invalid journal schema');
      const entries = parsed.pending;
      let skipped = 0;
      for (const entry of entries) {
        const record = parseRecord(entry);
        if (record && !this.records.has(record.id)) this.records.set(record.id, record);
        else skipped++;
      }
      if (skipped) this.loadFailed = true;
      this.logger.info('load - Pending action journal loaded', {
        pending: this.records.size,
        skipped
      });
    } catch (error) {
      // A corrupt journal is preserved under a sidecar name rather than overwritten, so the
      // bans it describes can still be found by hand.
      this.loadFailed = true;
      this.logger.error('load - Pending action journal is corrupt, keeping a copy', error, {
        action: 'journal_load'
      });
      await fs
        .copyFile(this.filePath, `${this.filePath}.corrupt`)
        .catch(renameError =>
          this.logger.error('load - Could not set the corrupt journal aside', renameError)
        );
    }
  }

  /** True when the journal could not be trusted at startup. Recovery reports this. */
  public get degraded(): boolean {
    return this.loadFailed;
  }

  /**
   * Write the journal through a temp file and a rename.
   *
   * Returns the chained promise so a caller that needs the record on disk before acting
   * (which, for a softban, is the whole point) can await it. Failures reject so the caller
   * can decide, rather than disappearing into the log.
   */
  private async persist(): Promise<void> {
    if (this.loadFailed) throw new Error('Journal requires operator repair before writes');
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const handle = await fs.open(tempPath, 'w', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ version: 1, pending: [...this.records.values()] }, null, 2));
        await handle.sync();
      } finally { await handle.close(); }
      await fs.rename(tempPath, this.filePath);
    } finally { await fs.rm(tempPath, { force: true }); }
  }

  private mutate<T>(operation: () => T): Promise<T> {
    const result = this.writeChain.then(async () => {
      const previous = structuredClone(this.records);
      try {
        const value = operation();
        await this.persist();
        return value;
      } catch (error) { this.records = previous; throw error; }
    });
    this.writeChain = result.then(() => {}, () => {});
    return result;
  }

  /**
   * Record the intent to softban, before anything is done to the member.
   *
   * A failure to persist is returned rather than thrown: the caller decides whether to go
   * ahead with an unrecoverable action. It logs loudly either way.
   */
  public async open(opts: {
    guildId: string;
    userId: string;
    userTag: string;
  }): Promise<{ id: string; persisted: boolean }> {
    const now = new Date().toISOString();
    const record: PendingAction = {
      id: randomUUID(),
      kind: 'softban',
      guildId: opts.guildId,
      userId: opts.userId,
      userTag: opts.userTag,
      phase: 'ban_pending',
      openedAt: now,
      updatedAt: now,
      recoveryAttempts: 0
    };
    try {
      await this.mutate(() => this.records.set(record.id, record));
      return { id: record.id, persisted: true };
    } catch (error) {
      this.logger.error('open - Could not journal a softban before acting', error, {
        guildId: opts.guildId,
        action: 'softban_open'
      });
      return { id: record.id, persisted: false };
    }
  }

  public async setPhase(id: string, phase: PendingPhase, detail?: string, retryAt?: number): Promise<void> {
    await this.mutate(() => {
      const record = this.records.get(id);
      if (!record) return;
      record.phase = phase;
      record.updatedAt = new Date().toISOString();
      if (detail !== undefined) record.detail = detail.slice(0, 500);
      if (retryAt !== undefined) record.retryAt = retryAt;
    }).catch(error => this.logger.error('setPhase - Could not journal phase change', error));
  }

  public async noteRecoveryAttempt(id: string, detail?: string): Promise<void> {
    await this.mutate(() => {
      const record = this.records.get(id);
      if (!record) return;
      record.recoveryAttempts += 1;
      record.updatedAt = new Date().toISOString();
      if (detail !== undefined) record.detail = detail.slice(0, 500);
    }).catch(error => this.logger.error('noteRecoveryAttempt - Could not journal recovery attempt', error));
  }

  public async resolve(id: string): Promise<void> {
    await this.mutate(() => this.records.delete(id))
      .catch(error => this.logger.error('resolve - Could not journal resolution', error));
  }

  public list(): PendingAction[] {
    return structuredClone([...this.records.values()]);
  }

  public listForGuild(guildId: string): PendingAction[] {
    return this.list().filter(record => record.guildId === guildId);
  }

  /** Records a human still has to deal with. */
  public listUnresolved(): PendingAction[] {
    return this.list().filter(
      record => record.phase === 'unresolved' || record.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS
    );
  }

  /** Wait for every queued write to land. Called on shutdown. */
  public async flush(): Promise<void> {
    await this.writeChain;
  }
}
