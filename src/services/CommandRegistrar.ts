import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { REST, Routes } from 'discord.js';
import { Command } from '../core/Command.js';
import { Logger } from './Logger.js';

/** What a registration attempt did. */
export type RegistrationOutcome = 'registered' | 'unchanged' | 'failed';

export interface RegistrationResult {
  outcome: RegistrationOutcome;
  /** Fingerprint of the command set this run was working with. */
  hash: string;
  /** How many commands are in the payload. */
  count: number;
  error?: unknown;
}

/** The one call this needs from Discord, kept behind an interface for tests. */
export interface CommandApi {
  put(clientId: string, body: unknown[]): Promise<unknown>;
}

interface RegistrationState {
  hash: string;
  clientId: string;
  count: number;
  registeredAt: string;
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

/**
 * Registers slash commands with Discord on boot, and skips the call when
 * nothing about them has changed.
 *
 * The bot's host restarts it on a schedule, so "register every boot" would mean
 * a redundant round trip twice a day forever. The payload is fingerprinted and
 * the fingerprint is kept in DATA_DIR beside the guild config, so a boot that
 * changes nothing costs nothing and a boot that adds or edits a command
 * registers itself without anyone touching the panel.
 *
 * On Discord's limits: there is a documented cap of 200 application command
 * creates per day per guild, and the bulk overwrite used here only counts
 * commands whose names do not already exist, so re-sending an unchanged set was
 * never going to exhaust the quota. The fingerprint is about not making a
 * pointless API call, and about leaving the quota alone for someone who is
 * genuinely iterating on command names.
 */
export class CommandRegistrar {
  private logger = new Logger({ context: 'CommandRegistrar' });
  private statePath: string;
  private api: CommandApi;

  constructor(
    private commands: Command[],
    private options: { clientId: string; dataDir: string; token?: string; api?: CommandApi }
  ) {
    this.statePath = path.resolve(options.dataDir, 'commands.json');
    this.api = options.api ?? this.createRestApi();
  }

  private createRestApi(): CommandApi {
    const rest = new REST().setToken(this.options.token ?? '');
    return {
      put: (clientId, body) => rest.put(Routes.applicationCommands(clientId), { body })
    };
  }

  /**
   * Push the command set to Discord unless it is already the one registered.
   *
   * Never throws. A bot that cannot register its commands is still a bot that
   * can run every command already registered, so a failure here is logged and
   * reported rather than allowed to take the process down on a restart the
   * operator is not watching.
   */
  public async register({ force = false }: { force?: boolean } = {}): Promise<RegistrationResult> {
    const body = this.commands.map(command => command.getRegistrationData());
    const hash = this.fingerprint(body);
    const count = body.length;

    if (!force) {
      const previous = await this.readState();
      if (previous?.hash === hash) {
        this.logger.info(`register - ${count} command(s) already registered and unchanged, skipping (${this.short(hash)})`);
        return { outcome: 'unchanged', hash, count };
      }
    }

    this.logger.info(`register - Registering ${count} command(s) with Discord (${this.short(hash)})...`);

    try {
      await this.api.put(this.options.clientId, body);
    } catch (error) {
      this.logger.error(
        'register - Failed to register commands with Discord. The bot is still running, and any commands ' +
        'registered previously still work. It will try again on the next restart, or run `npm run register` ' +
        'to do it by hand:',
        error
      );
      return { outcome: 'failed', hash, count, error };
    }

    await this.writeState({ hash, clientId: this.options.clientId, count, registeredAt: new Date().toISOString() });

    for (const command of this.commands) {
      this.logger.info(`register - Registered: /${command.getName()} [${command.getHelpInfo().category}] - ${command.getDescription()}`);
    }
    this.logger.info(`register - ${count} command(s) registered`);

    return { outcome: 'registered', hash, count };
  }

  /**
   * Fingerprint of the exact payload, scoped to the application it was sent to.
   * Point the bot at a different client ID and whatever that application has
   * registered is unknown to us, so it re-registers rather than trusting a hash
   * that was written about somebody else.
   */
  private fingerprint(body: unknown[]): string {
    return createHash('sha256')
      .update(stableStringify({ clientId: this.options.clientId, commands: body }))
      .digest('hex');
  }

  private short(hash: string): string {
    return hash.slice(0, 12);
  }

  /** The last successful registration, or null if there is nothing usable. */
  private async readState(): Promise<RegistrationState | null> {
    try {
      const raw = await fs.readFile(this.statePath, 'utf-8');
      const parsed = JSON.parse(raw) as RegistrationState;
      return typeof parsed?.hash === 'string' ? parsed : null;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        this.logger.warn('readState - Could not read the registration record, treating commands as unregistered:', error);
      }
      return null;
    }
  }

  /**
   * Written only after Discord accepts the payload, so a failed run leaves the
   * old fingerprint in place and the next boot tries again.
   */
  private async writeState(state: RegistrationState): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.statePath), { recursive: true });
      await fs.writeFile(this.statePath, JSON.stringify(state, null, 2), 'utf-8');
    } catch (error) {
      this.logger.warn(
        'writeState - Commands registered, but the record could not be saved. They will be re-registered on the next restart:',
        error
      );
    }
  }
}
