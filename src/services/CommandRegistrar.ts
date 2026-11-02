import { promises as fs } from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { REST, Routes } from 'discord.js';
import { Command } from '../core/Command.js';
import { Logger } from './Logger.js';

/** Where a command set is being written: every installation, or one test guild. */
export type RegistrationTarget =
  | { scope: 'global' }
  | { scope: 'guild'; guildId: string };

/** What a registration attempt did. */
export type RegistrationOutcome = 'registered' | 'unchanged' | 'cleared' | 'failed';

export interface RegistrationResult {
  outcome: RegistrationOutcome;
  /** The target this run was writing to. */
  target: RegistrationTarget;
  /** Fingerprint of the command set this run was working with. */
  hash: string;
  /** How many commands are in the payload. */
  count: number;
  error?: unknown;
}

/** What a registration would do, without doing it. */
export interface RegistrationPlan {
  target: RegistrationTarget;
  hash: string;
  count: number;
  /** False when the target already holds this exact payload. */
  changed: boolean;
  previousHash: string | null;
  added: string[];
  removed: string[];
  modified: string[];
  /**
   * True when no payload is retained for this target, so the per-command lists
   * are empty because the comparison could not be made, not because the
   * command set matches.
   */
  baselineUnknown: boolean;
}

/** The one call this needs from Discord, kept behind an interface for tests. */
export interface CommandApi {
  put(target: RegistrationTarget, body: unknown[]): Promise<unknown>;
}

/** A payload that was live at some point, kept so it can be re-sent. */
interface RetainedPayload {
  hash: string;
  count: number;
  registeredAt: string;
  /** Null for records written before payloads were retained. */
  payload: unknown[] | null;
}

interface TargetRecord extends RetainedPayload {
  clientId: string;
  scope: 'global' | 'guild';
  guildId?: string;
  /** The payload this target held before the current one, for rollback. */
  previous?: RetainedPayload;
}

interface RegistrationFile {
  version: number;
  targets: Record<string, TargetRecord>;
}

const STATE_VERSION = 1;

/** Stable key for a target in the state file. */
export function targetKey(target: RegistrationTarget): string {
  return target.scope === 'guild' ? `guild:${target.guildId}` : 'global';
}

/** Target as it reads in a log line. */
export function describeTarget(target: RegistrationTarget): string {
  return target.scope === 'guild' ? `guild ${target.guildId}` : 'global';
}

/**
 * Which target this environment is allowed to write to.
 *
 * Global registration changes the command set for every installation at once,
 * so it is gated on `NODE_ENV=production` being set deliberately. Anything else
 * is treated as development and has to name a test guild, which keeps a
 * half-finished command off other people's servers. Callers that genuinely want
 * global from a non-production shell pass the target explicitly.
 */
export function resolveRegistrationTarget(options: {
  nodeEnv: string;
  devGuildId?: string;
}): RegistrationTarget {
  if (options.nodeEnv === 'production') {
    return { scope: 'global' };
  }

  if (!options.devGuildId) {
    throw new Error(
      `Refusing to register commands globally with NODE_ENV="${options.nodeEnv}". ` +
      'Set DEV_GUILD_ID to register to a test guild, pass --global to override, or set NODE_ENV=production.'
    );
  }

  return { scope: 'guild', guildId: options.devGuildId };
}

/**
 * Serialize with object keys in a fixed order, so the fingerprint tracks what
 * the payload says rather than the order a builder happened to write its keys.
 * Without this a discord.js upgrade that reorders a field would look like a
 * changed command set and spend a registration for nothing.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
}

function commandName(entry: unknown): string {
  const name = (entry as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : '(unnamed)';
}

/**
 * Writes the slash command set to Discord, to one explicit target at a time.
 *
 * Registration is a release step, not a side effect of starting up: the call is
 * a bulk overwrite, so a build that drops a command drops it from every server
 * that has the bot. Nothing here runs on boot. An operator runs the register
 * script against a test guild, reviews the diff, then runs it global.
 *
 * Every call is idempotent. The payload is fingerprinted per application and
 * per target and the fingerprint is kept in DATA_DIR beside the guild config,
 * so re-running against an unchanged command set costs nothing, and the dev
 * guild's fingerprint never makes the global target look up to date. The
 * previous payload is retained so a bad release can be re-sent in reverse.
 *
 * The fingerprint is a record of what this bot last sent, not of what Discord
 * currently holds: commands edited from the portal or by another instance are
 * invisible to it. `--force` is how you resync when they disagree.
 *
 * On Discord's limits: there is a per-day cap on application command creates,
 * and a bulk overwrite is documented to count only commands whose names do not
 * already exist, so re-sending an unchanged set was never going to exhaust it.
 * Both figures need confirming against current platform documentation before
 * release rather than taken from this comment.
 */
export class CommandRegistrar {
  private logger = new Logger({ context: 'CommandRegistrar' });
  private statePath: string;
  private api: CommandApi;
  private target: RegistrationTarget;

  constructor(
    private commands: Command[],
    private options: {
      clientId: string;
      dataDir: string;
      target: RegistrationTarget;
      token?: string;
      api?: CommandApi;
    }
  ) {
    this.target = options.target;
    this.statePath = path.resolve(options.dataDir, 'commands.json');
    this.api = options.api ?? this.createRestApi();
  }

  private createRestApi(): CommandApi {
    const rest = new REST().setToken(this.options.token ?? '');
    return {
      put: (target, body) =>
        rest.put(
          target.scope === 'guild'
            ? Routes.applicationGuildCommands(this.options.clientId, target.guildId)
            : Routes.applicationCommands(this.options.clientId),
          { body }
        )
    };
  }

  /** The target this registrar writes to. */
  public getTarget(): RegistrationTarget {
    return this.target;
  }

  /**
   * What `register` would send, and how it differs from the retained payload.
   *
   * This is the reviewed-diff step before a global release. It reads state and
   * never calls Discord.
   */
  public async plan(): Promise<RegistrationPlan> {
    const body = this.buildPayload();
    const hash = this.fingerprint(body);
    const record = await this.readRecord();
    const diff = this.diffPayloads(record?.payload ?? null, body);

    return {
      target: this.target,
      hash,
      count: body.length,
      changed: record?.hash !== hash,
      previousHash: record?.hash ?? null,
      ...diff
    };
  }

  /**
   * Push the command set to this target unless it is already the one
   * registered.
   *
   * Never throws. A bot that cannot register its commands is still a bot that
   * can run every command already registered, so a failure here is reported
   * rather than allowed to take a process down.
   */
  public async register({ force = false }: { force?: boolean } = {}): Promise<RegistrationResult> {
    const body = this.buildPayload();
    const hash = this.fingerprint(body);
    const count = body.length;
    const where = describeTarget(this.target);

    const file = await this.readState();
    const record = this.ownRecord(file);

    if (!force && record?.hash === hash) {
      this.logger.info(
        `register - ${count} command(s) already registered on ${where} and unchanged, skipping (${this.short(hash)})`
      );
      return { outcome: 'unchanged', target: this.target, hash, count };
    }

    this.logger.info(`register - Registering ${count} command(s) on ${where} (${this.short(hash)})...`);

    try {
      await this.api.put(this.target, body);
    } catch (error) {
      this.logger.error(
        `register - Failed to register commands on ${where}. Any commands registered previously still ` +
        'work, and the stored fingerprint is unchanged so the next run tries again:',
        error
      );
      return { outcome: 'failed', target: this.target, hash, count, error };
    }

    await this.commitRecord(file, { hash, count, payload: body });

    for (const command of this.commands) {
      this.logger.info(
        `register - Registered: /${command.getName()} [${command.getHelpInfo().category}] - ${command.getDescription()}`
      );
    }
    this.logger.info(`register - ${count} command(s) registered on ${where}`);

    return { outcome: 'registered', target: this.target, hash, count };
  }

  /**
   * Re-send the payload this target held before the current one.
   *
   * Rollback is a registration like any other, so the payload being replaced
   * becomes the new rollback point: running it twice returns you to where you
   * started rather than walking further back.
   */
  public async rollback(): Promise<RegistrationResult | null> {
    const file = await this.readState();
    const record = this.ownRecord(file);
    const previous = record?.previous;

    if (!previous?.payload) {
      this.logger.warn(
        `rollback - No previous payload retained for ${describeTarget(this.target)}, nothing to roll back to`
      );
      return null;
    }

    const where = describeTarget(this.target);
    const body = previous.payload;
    const hash = this.fingerprint(body);

    this.logger.info(
      `rollback - Restoring the ${body.length} command(s) registered on ${where} at ${previous.registeredAt} ` +
      `(${this.short(hash)})...`
    );

    try {
      await this.api.put(this.target, body);
    } catch (error) {
      this.logger.error(`rollback - Failed to restore the previous payload on ${where}:`, error);
      return { outcome: 'failed', target: this.target, hash, count: body.length, error };
    }

    await this.commitRecord(file, { hash, count: body.length, payload: body });
    this.logger.info(`rollback - ${body.length} command(s) restored on ${where}`);

    return { outcome: 'registered', target: this.target, hash, count: body.length };
  }

  /**
   * Remove every command from this target.
   *
   * Guild commands shadow the global ones of the same name, so a test guild
   * that is left registered keeps serving an old build to the one server most
   * likely to be checking the new one. Clearing it is deliberate and explicit:
   * it is never inferred from a target switch.
   */
  public async clear(): Promise<RegistrationResult> {
    const where = describeTarget(this.target);
    const file = await this.readState();
    const key = targetKey(this.target);

    this.logger.info(`clear - Removing all commands from ${where}...`);

    try {
      await this.api.put(this.target, []);
    } catch (error) {
      this.logger.error(`clear - Failed to remove commands from ${where}:`, error);
      return { outcome: 'failed', target: this.target, hash: '', count: 0, error };
    }

    await this.commitRecord(file, { hash: this.fingerprint([]), count: 0, payload: [] });

    this.logger.info(`clear - ${where} now has no application commands`);
    return { outcome: 'cleared', target: this.target, hash: '', count: 0 };
  }

  private buildPayload(): unknown[] {
    return this.commands.map(command => command.getRegistrationData());
  }

  /**
   * Fingerprint of the exact payload, scoped to the application and the target
   * it was sent to. Point the bot at a different client ID, or switch from the
   * dev guild to global, and whatever that target has registered is unknown to
   * us, so it re-registers rather than trusting a hash that was written about
   * somebody else.
   */
  private fingerprint(body: unknown[]): string {
    return createHash('sha256')
      .update(
        stableStringify({
          clientId: this.options.clientId,
          target: targetKey(this.target),
          commands: body
        })
      )
      .digest('hex');
  }

  private short(hash: string): string {
    return hash.slice(0, 12);
  }

  /** Which command names were added, dropped or edited between two payloads. */
  private diffPayloads(
    previous: unknown[] | null,
    next: unknown[]
  ): { added: string[]; removed: string[]; modified: string[]; baselineUnknown: boolean } {
    if (!previous) {
      return { added: [], removed: [], modified: [], baselineUnknown: true };
    }

    const before = new Map(previous.map(entry => [commandName(entry), stableStringify(entry)]));
    const after = new Map(next.map(entry => [commandName(entry), stableStringify(entry)]));

    const added = [...after.keys()].filter(name => !before.has(name));
    const removed = [...before.keys()].filter(name => !after.has(name));
    const modified = [...after.keys()].filter(name => before.has(name) && before.get(name) !== after.get(name));

    return { added, removed, modified, baselineUnknown: false };
  }

  private ownRecord(file: RegistrationFile): TargetRecord | undefined {
    const record = file.targets[targetKey(this.target)];
    return record?.clientId === this.options.clientId ? record : undefined;
  }

  private async readRecord(): Promise<TargetRecord | undefined> {
    const file = await this.readState();
    return this.ownRecord(file);
  }

  /**
   * Record a successful write, keeping the payload it replaced for rollback.
   *
   * Only ever called after Discord accepts the payload, so a failed run leaves
   * the old fingerprint in place and the next run tries again.
   */
  private async commitRecord(
    file: RegistrationFile,
    written: { hash: string; count: number; payload: unknown[] }
  ): Promise<void> {
    const key = targetKey(this.target);
    const current = this.ownRecord(file);

    file.targets[key] = {
      hash: written.hash,
      count: written.count,
      payload: written.payload,
      registeredAt: new Date().toISOString(),
      clientId: this.options.clientId,
      scope: this.target.scope,
      ...(this.target.scope === 'guild' ? { guildId: this.target.guildId } : {}),
      ...(current
        ? {
            previous: {
              hash: current.hash,
              count: current.count,
              registeredAt: current.registeredAt,
              payload: current.payload
            }
          }
        : {})
    };

    await this.writeState(file);
  }

  /**
   * Every target's last successful registration, or an empty set if there is
   * nothing usable on disk.
   *
   * A file that will not parse is kept aside rather than overwritten: it holds
   * the rollback payloads, and a truncated write is worth looking at.
   */
  private async readState(): Promise<RegistrationFile> {
    let raw: string;

    try {
      raw = await fs.readFile(this.statePath, 'utf-8');
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw new Error('Registration state is unreadable; restore it before registering');
      return { version: STATE_VERSION, targets: {} };
    }

    try {
      return this.parseState(JSON.parse(raw));
    } catch (error) {
      await this.quarantineState(raw, error);
      return { version: STATE_VERSION, targets: {} };
    }
  }

  /** Accepts the current shape and the flat single-target record it replaced. */
  private parseState(parsed: unknown): RegistrationFile {
    const record = parsed as Partial<RegistrationFile> & Partial<TargetRecord>;

    if (record?.version !== undefined && record.version !== STATE_VERSION) throw new Error('Unsupported registration state version');
    if (record?.targets && typeof record.targets === 'object' && !Array.isArray(record.targets)) {
      return { version: record.version ?? STATE_VERSION, targets: record.targets };
    }

    // Pre-target state files held one global registration at the top level.
    if (typeof record?.hash === 'string' && typeof record?.clientId === 'string') {
      return {
        version: STATE_VERSION,
        targets: {
          global: {
            hash: record.hash,
            clientId: record.clientId,
            scope: 'global',
            count: record.count ?? 0,
            registeredAt: record.registeredAt ?? new Date(0).toISOString(),
            payload: null
          }
        }
      };
    }

    throw new Error('Unrecognized registration state');
  }

  private async quarantineState(raw: string, error: unknown): Promise<void> {
    const kept = `${this.statePath}.unreadable`;

    try {
      await fs.writeFile(kept, raw, 'utf-8');
    } catch {
      // Best effort: the warning below is the part that matters.
    }

    this.logger.warn(
      `readState - The registration record at ${this.statePath} could not be read, so every target is ` +
      `treated as unregistered and the rollback payloads are gone. A copy is at ${kept}:`,
      error
    );
  }

  /**
   * Written via a temporary file and a rename, so an interrupted write cannot
   * leave a half-written record where the rollback payloads used to be.
   */
  private async writeState(file: RegistrationFile): Promise<void> {
    const temp = `${this.statePath}.${randomUUID()}.tmp`;

    try {
      await fs.mkdir(path.dirname(this.statePath), { recursive: true });
      await fs.writeFile(temp, JSON.stringify({ ...file, version: STATE_VERSION }, null, 2), 'utf-8');
      await fs.rename(temp, this.statePath);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      this.logger.warn(
        'writeState - Commands registered, but the record could not be saved. The next run will see this ' +
        'target as unregistered and re-send the same payload:',
        error
      );
    }
  }
}
