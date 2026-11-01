import { promises as fs } from 'fs';
import path from 'path';
import { Logger } from './Logger.js';

/** What the bot does to someone the trap catches. */
export type HoneypotAction = 'quarantine' | 'timeout' | 'kick' | 'ban';

export const HONEYPOT_ACTIONS: readonly HoneypotAction[] = [
  'quarantine',
  'timeout',
  'kick',
  'ban'
];

/** Applied when a server never picked an action. */
export const DEFAULT_HONEYPOT_ACTION: HoneypotAction = 'kick';

export function isHoneypotAction(value: unknown): value is HoneypotAction {
  return typeof value === 'string' && (HONEYPOT_ACTIONS as readonly string[]).includes(value);
}

/** One recorded catch, kept for the stats view and the live counter on the trap. */
export interface CatchRecord {
  userId: string;
  userTag: string;
  /** The action that actually ran, or 'none' when the offender was exempt or it failed. */
  action: HoneypotAction | 'none';
  /** Whether a young account forced an escalation to a ban. */
  escalated: boolean;
  /** How they tripped the trap. */
  source: 'message' | 'button';
  caughtAt: string;
}

/** Per-guild trap configuration, keyed by guild ID. */
export interface GuildConfig {
  channelId: string;
  /** The "Hide Honeypot" role, denied View on the trap so members can opt out of seeing it. */
  hideRoleId?: string;
  /**
   * Whether the bot created the trap channel itself, as opposed to converting one that
   * already existed. `/honeypot remove` deletes a channel it made and un-converts one it
   * did not. Absent on records written before this was tracked, which reads as "no record
   * either way" rather than as false.
   */
  createdByBot?: boolean;
  /** The sticky trap message, re-posted after each catch so it stays the newest message. */
  messageId?: string;
  action?: HoneypotAction;
  /** Where action reports go. Unset means reports are logged to the console only. */
  logChannelId?: string;
  /** Roles the trap is hidden from entirely, via a View-deny overwrite each. */
  hideFromRoleIds?: string[];
  /**
   * The role overwrites this bot actually wrote on the trap channel.
   *
   * Tracked separately from hideFromRoleIds so cleanup only ever removes overwrites the
   * bot is responsible for. On a converted channel the admin may already have View-denies
   * of their own, and deleting those would quietly undo server config the bot never owned.
   */
  appliedHideRoleIds?: string[];
  /** Users the trap never acts on. */
  exemptUserIds?: string[];
  /** Members holding any of these roles are never acted on. */
  exemptRoleIds?: string[];
  /** The quarantine role, created on demand by the quarantine action. */
  quarantineRoleId?: string;
  /** Recorded catches, newest last. Trimmed to CATCH_HISTORY_LIMIT. */
  catches?: CatchRecord[];
}

interface StoreShape {
  guilds: Record<string, GuildConfig>;
}

/**
 * How many catches to keep per guild. The stats view shows a handful and the counter only
 * needs a total, so an unbounded list would grow forever to display the same numbers. The
 * total is tracked separately so trimming never rewrites history.
 */
const CATCH_HISTORY_LIMIT = 50;

/**
 * Persists trap configuration and catch history to a JSON file, so the bot survives
 * restarts on hosts that redeploy on boot.
 *
 * The store is a process-wide singleton. Writes are serialized through a single-flight
 * promise chain so two catches landing at once cannot corrupt the file.
 */
export class GuildConfigStore {
  private static instance: GuildConfigStore | null = null;

  private logger = new Logger({ context: 'GuildConfigStore' });
  private data: StoreShape = { guilds: {} };
  private totals: Record<string, number> = {};
  private filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(dataDir: string) {
    this.filePath = path.resolve(dataDir, 'guilds.json');
  }

  /** Initialize the singleton and load any persisted state from disk. */
  public static async init(dataDir: string): Promise<GuildConfigStore> {
    if (!GuildConfigStore.instance) {
      GuildConfigStore.instance = new GuildConfigStore(dataDir);
      await GuildConfigStore.instance.load();
    }
    return GuildConfigStore.instance;
  }

  public static getInstance(): GuildConfigStore | null {
    return GuildConfigStore.instance;
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as StoreShape & { totals?: Record<string, number> };
      this.data = { guilds: parsed.guilds ?? {} };
      this.totals = parsed.totals ?? {};
      // Defensive: an older file may predate any of these fields.
      for (const [guildId, config] of Object.entries(this.data.guilds)) {
        if (!config.catches) config.catches = [];
        if (this.totals[guildId] === undefined) this.totals[guildId] = config.catches.length;
      }
      this.logger.info(`load - Loaded config for ${Object.keys(this.data.guilds).length} guild(s)`);
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        this.logger.info('load - No existing config file, starting fresh');
      } else {
        this.logger.error('load - Failed to read config file, starting fresh:', error);
      }
      this.data = { guilds: {} };
      this.totals = {};
    }
  }

  /** Serialize writes so concurrent catches never interleave on the file. */
  private persist(): Promise<void> {
    this.writeChain = this.writeChain
      .then(async () => {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.writeFile(
          this.filePath,
          JSON.stringify({ guilds: this.data.guilds, totals: this.totals }, null, 2),
          'utf-8'
        );
      })
      .catch(error => {
        this.logger.error('persist - Failed to write config file:', error);
      });
    return this.writeChain;
  }

  /**
   * Wait for every queued write to land.
   *
   * Called on shutdown. Writes are chained rather than immediate, so without this a catch
   * recorded in the last moments before a restart can be lost even though it succeeded.
   */
  public async flush(): Promise<void> {
    await this.writeChain;
  }

  public getGuild(guildId: string): GuildConfig | undefined {
    return this.data.guilds[guildId];
  }

  public getAllGuilds(): Array<{ guildId: string; config: GuildConfig }> {
    return Object.entries(this.data.guilds).map(([guildId, config]) => ({ guildId, config }));
  }

  /** True when this channel is the guild's trap. */
  public isTrapChannel(guildId: string, channelId: string): boolean {
    return this.data.guilds[guildId]?.channelId === channelId;
  }

  /** Store or replace the trap for a guild, preserving settings that outlive a re-setup. */
  public async setTrap(
    guildId: string,
    trap: Pick<GuildConfig, 'channelId' | 'hideRoleId' | 'createdByBot' | 'messageId' | 'action'>
  ): Promise<void> {
    const existing = this.data.guilds[guildId];
    this.data.guilds[guildId] = {
      ...trap,
      logChannelId: existing?.logChannelId,
      hideFromRoleIds: existing?.hideFromRoleIds,
      // A new channel carries none of the old one's overwrites, so ownership resets.
      appliedHideRoleIds: [],
      exemptUserIds: existing?.exemptUserIds,
      exemptRoleIds: existing?.exemptRoleIds,
      quarantineRoleId: existing?.quarantineRoleId,
      catches: existing?.catches ?? []
    };
    await this.persist();
  }

  /** Forget a guild entirely, putting the bot back where it was before `/honeypot setup`. */
  public async removeGuild(guildId: string): Promise<void> {
    if (!this.data.guilds[guildId]) return;
    delete this.data.guilds[guildId];
    delete this.totals[guildId];
    await this.persist();
  }

  public async patchGuild(guildId: string, patch: Partial<GuildConfig>): Promise<void> {
    const config = this.data.guilds[guildId];
    if (!config) return;
    Object.assign(config, patch);
    await this.persist();
  }

  public async setStickyMessage(guildId: string, messageId: string | undefined): Promise<void> {
    const config = this.data.guilds[guildId];
    if (!config) return;
    config.messageId = messageId;
    await this.persist();
  }

  /** Record a catch and return the guild's new lifetime total. */
  public async recordCatch(guildId: string, record: CatchRecord): Promise<number> {
    const config = this.data.guilds[guildId];
    if (!config) return this.totals[guildId] ?? 0;
    if (!config.catches) config.catches = [];
    config.catches.push(record);
    if (config.catches.length > CATCH_HISTORY_LIMIT) {
      config.catches = config.catches.slice(-CATCH_HISTORY_LIMIT);
    }
    this.totals[guildId] = (this.totals[guildId] ?? 0) + 1;
    await this.persist();
    return this.totals[guildId];
  }

  /** Lifetime catch count, which outlives the trimmed history. */
  public getCatchTotal(guildId: string): number {
    return this.totals[guildId] ?? 0;
  }

  public getRecentCatches(guildId: string, limit = 5): CatchRecord[] {
    const catches = this.data.guilds[guildId]?.catches ?? [];
    return catches.slice(-limit).reverse();
  }

  /** Counts by action across the retained history, for the stats breakdown. */
  public getActionBreakdown(guildId: string): Record<string, number> {
    const breakdown: Record<string, number> = {};
    for (const record of this.data.guilds[guildId]?.catches ?? []) {
      breakdown[record.action] = (breakdown[record.action] ?? 0) + 1;
    }
    return breakdown;
  }
}
