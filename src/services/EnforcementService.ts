import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type Role,
  type User
} from 'discord.js';
import { DiscordApi, type ActionResult } from './DiscordApi.js';
import {
  DEFAULT_HONEYPOT_ACTION,
  GuildConfigStore,
  type HoneypotAction
} from './GuildConfigStore.js';
import { HoneypotService } from './HoneypotService.js';
import { Logger } from './Logger.js';
import { QUARANTINE_ROLE_NAME, actionReportEmbed, offenderDmEmbed } from '../config/honeypotText.js';

/** Seven days, the window for both the timeout length and the young-account escalation. */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Discord's epoch, for reading an account's creation time out of its snowflake. */
const DISCORD_EPOCH = 1420070400000;

/** How much recent history a ban or softban purges, in seconds. Discord's maximum. */
const PURGE_SECONDS = 604800;

export interface CatchOutcome {
  action: HoneypotAction | 'none';
  escalated: boolean;
  result: ActionResult;
  skipped: boolean;
}

/**
 * Turns a catch into an action, a record and a report.
 *
 * This is the single place a trap trip becomes something that happens to a person, so
 * every path into it (a message in the channel, a decoy button press) gets the same
 * exemptions, the same escalation rule and the same reporting.
 */
export class EnforcementService {
  private static logger = new Logger({ context: 'EnforcementService' });

  /**
   * Apply a catch end to end.
   *
   * The order matters: exemptions first so a protected member is never touched, then the
   * action, then the record, then the report. Everything after the action is best effort,
   * because a failure to log must not look like a failure to act.
   */
  public static async handleCatch(opts: {
    guild: Guild;
    user: User;
    member: GuildMember | null;
    trigger: string;
    source: 'message' | 'button';
    /** The button path always kicks; the message path uses the configured action. */
    requestedAction?: HoneypotAction;
  }): Promise<CatchOutcome> {
    const { guild, user, member, trigger, source } = opts;
    const store = GuildConfigStore.getInstance();
    const config = store?.getGuild(guild.id);
    if (!store || !config) {
      return { action: 'none', escalated: false, result: 'error', skipped: true };
    }

    if (await this.isExempt(guild, user, member, config.exemptUserIds, config.exemptRoleIds)) {
      this.logger.info(`handleCatch - ${user.id} is exempt in ${guild.id}, taking no action`);
      return { action: 'none', escalated: false, result: 'success', skipped: true };
    }

    // A throwaway account that trips the trap is escalated to a real ban regardless of the
    // configured action. Spam rings cycle fresh accounts, and a kick just invites the next one.
    const escalated = isNewAccount(user.id, Date.now());
    const requested = opts.requestedAction ?? config.action ?? DEFAULT_HONEYPOT_ACTION;
    const action: HoneypotAction = escalated ? 'ban' : requested;

    const reason = `Honeypot: ${trigger}. Automatic ${action}${
      escalated ? ', escalated because the account is under 7 days old' : ''
    }.`;

    let result: ActionResult = 'error';
    let finalAction: HoneypotAction | 'none' = action;
    let unbanFailed = false;

    try {
      switch (action) {
        case 'ban':
          result = await DiscordApi.banMember(guild.id, user.id, reason, PURGE_SECONDS);
          break;

        case 'kick': {
          // A kick is carried out as a softban: ban with a 7 day purge, then unban. The net
          // effect is a kick, but it also wipes the spam from every channel in one call,
          // which a plain kick cannot do. If the ban fails there is nothing to undo.
          result = await DiscordApi.banMember(
            guild.id,
            user.id,
            `${reason} [softban: kick and purge]`,
            PURGE_SECONDS
          );
          if (result === 'success') {
            const unban = await DiscordApi.softbanUnban(guild.id, user.id);
            if (unban.unbanFailed) {
              unbanFailed = true;
              this.logger.error(
                `handleCatch - Softban unban FAILED for ${user.id} in ${guild.id}: ${unban.detail}. The member is still banned though the configured action was kick`
              );
            }
          }
          break;
        }

        case 'timeout':
          result = await this.timeoutMember(member, reason);
          break;

        case 'quarantine': {
          const quarantined = await this.quarantineMember(guild, member, reason);
          result = quarantined;
          if (quarantined !== 'success') finalAction = 'none';
          break;
        }
      }
    } catch (error) {
      this.logger.error(`handleCatch - Action threw for ${user.id} in ${guild.id}:`, error);
      result = 'error';
    }

    if (result === 'missing_perms' || result === 'error') {
      // Say this loudly in the console as well as the log channel. The permission that
      // blocks a ban often blocks posting the report too, so the report alone can vanish.
      this.logger.error(
        `handleCatch - Action FAILED in ${guild.id} for ${user.id}: action=${action} result=${result} escalated=${escalated}. Most likely a missing Ban Members permission or my role sitting below theirs.`
      );
    }

    const total = await store.recordCatch(guild.id, {
      userId: user.id,
      userTag: user.tag,
      action: finalAction,
      escalated,
      source,
      caughtAt: new Date().toISOString()
    });
    this.logger.info(
      `handleCatch - ${user.tag} (${user.id}) caught in ${guild.id}: ${finalAction}, total ${total}`
    );

    // A courtesy, and best effort by design. Opening a DM channel with someone who has
    // just been banned usually fails unless one already existed, which for a throwaway
    // spam account it will not. Worth attempting for the humans who trip this by accident.
    await this.dmOffender(user, guild, action, trigger, escalated);

    await this.postReport({
      guild,
      user,
      action: finalAction,
      trigger,
      escalated,
      failed: result === 'missing_perms' || result === 'error',
      unbanFailed
    });

    return { action: finalAction, escalated, result, skipped: false };
  }

  /**
   * Never act on the server owner, the bot itself, or anyone staff exempted.
   *
   * Other moderators are protected by Discord's own role hierarchy: an action against
   * someone above the bot fails loudly rather than silently, which is the behaviour we want.
   */
  public static async isExempt(
    guild: Guild,
    user: User,
    member: GuildMember | null,
    exemptUserIds: string[] | undefined,
    exemptRoleIds: string[] | undefined
  ): Promise<boolean> {
    if (user.id === guild.client.user?.id) return true;
    if (user.id === guild.ownerId) return true;
    if (exemptUserIds?.includes(user.id)) return true;

    if (exemptRoleIds?.length) {
      const resolved = member ?? (await guild.members.fetch(user.id).catch(() => null));
      if (!resolved) return true; // Unknown role evidence must not bypass the allowlist.
      if (exemptRoleIds.some(roleId => resolved.roles.cache.has(roleId))) {
        return true;
      }
    }
    return false;
  }

  private static async timeoutMember(
    member: GuildMember | null,
    reason: string
  ): Promise<ActionResult> {
    if (!member) return 'error';
    try {
      await member.timeout(SEVEN_DAYS_MS, reason);
      return 'success';
    } catch (error: any) {
      this.logger.error(`timeoutMember - Failed for ${member.id}:`, error);
      return error?.code === 50013 ? 'missing_perms' : 'error';
    }
  }

  /**
   * Apply the quarantine role, creating and locking it down on first use.
   *
   * A bare role with no permissions does nothing on its own, so the first time this runs
   * the bot also writes a deny overwrite on every channel it can see. Without that step an
   * admin would pick Quarantine and watch nothing happen.
   */
  private static async quarantineMember(
    guild: Guild,
    member: GuildMember | null,
    reason: string
  ): Promise<ActionResult> {
    if (!member) return 'error';
    const role = await this.ensureQuarantineRole(guild);
    if (!role) return 'missing_perms';
    try {
      await member.roles.add(role, reason);
      return 'success';
    } catch (error: any) {
      this.logger.error(`quarantineMember - Failed for ${member.id}:`, error);
      return error?.code === 50013 ? 'missing_perms' : 'error';
    }
  }

  private static async ensureQuarantineRole(guild: Guild): Promise<Role | null> {
    const store = GuildConfigStore.getInstance();
    const known = store?.getGuild(guild.id)?.quarantineRoleId;
    if (known) {
      const cached = guild.roles.cache.get(known);
      if (cached) return cached;
    }

    const existing = guild.roles.cache.find(role => role.name === QUARANTINE_ROLE_NAME);
    if (existing) {
      await store?.patchGuild(guild.id, { quarantineRoleId: existing.id });
      return existing;
    }

    try {
      const role = await guild.roles.create({
        name: QUARANTINE_ROLE_NAME,
        permissions: [],
        hoist: false,
        mentionable: false,
        reason: 'Honeypot: quarantine role'
      });
      await this.lockChannelsForRole(guild, role);
      await store?.patchGuild(guild.id, { quarantineRoleId: role.id });
      return role;
    } catch (error) {
      this.logger.error(`ensureQuarantineRole - Could not create the role in ${guild.id}:`, error);
      return null;
    }
  }

  /** Deny View and Send to a role across every channel, so quarantine actually contains. */
  private static async lockChannelsForRole(guild: Guild, role: Role): Promise<void> {
    for (const channel of guild.channels.cache.values()) {
      if (!('permissionOverwrites' in channel)) continue;
      try {
        await channel.permissionOverwrites.edit(
          role,
          { ViewChannel: false, SendMessages: false },
          { reason: 'Honeypot: lock down the quarantine role' }
        );
      } catch {
        // A channel the bot cannot manage is skipped rather than aborting the lockdown.
      }
    }
  }

  private static async dmOffender(
    user: User,
    guild: Guild,
    action: HoneypotAction,
    trigger: string,
    escalated: boolean
  ): Promise<void> {
    try {
      await user.send({
        embeds: [offenderDmEmbed({ action, guildName: guild.name, trigger, escalated })]
      });
    } catch {
      // Closed DMs are the norm for the accounts this catches. Never load bearing.
    }
  }

  /**
   * Post the action report to the configured log channel.
   *
   * Deliberately never posts to the trap itself: the report names the offender, and the
   * trap is a public channel that anyone can read.
   */
  private static async postReport(opts: {
    guild: Guild;
    user: User;
    action: HoneypotAction | 'none';
    trigger: string;
    escalated: boolean;
    failed: boolean;
    unbanFailed: boolean;
  }): Promise<void> {
    const config = GuildConfigStore.getInstance()?.getGuild(opts.guild.id);
    if (!config?.logChannelId) return;
    if (config.logChannelId === config.channelId) {
      this.logger.warn(
        `postReport - The log channel for ${opts.guild.id} is the trap itself, skipping to avoid naming the offender publicly`
      );
      return;
    }

    const channel = opts.guild.channels.cache.get(config.logChannelId);
    if (!channel || channel.type !== ChannelType.GuildText) return;

    try {
      await channel.send({
        embeds: [
          actionReportEmbed({
            userId: opts.user.id,
            userTag: opts.user.tag,
            avatarUrl: opts.user.displayAvatarURL(),
            action: opts.action,
            trigger: opts.trigger,
            escalated: opts.escalated,
            failed: opts.failed,
            unbanFailed: opts.unbanFailed
          })
        ]
      });
    } catch (error) {
      this.logger.error(`postReport - Could not post to ${config.logChannelId}:`, error);
    }
  }

  /** Re-sticky the trap after a catch so it stays visible above the mess. */
  public static async refreshTrap(guild: Guild): Promise<void> {
    await HoneypotService.refreshSticky(guild);
  }

  /** Does the bot hold the permissions the configured action needs? Used by setup. */
  public static missingPermissionsFor(guild: Guild, action: HoneypotAction): string[] {
    const me = guild.members.me;
    if (!me) return [];
    const needed: Array<[bigint, string]> = [];
    if (action === 'ban' || action === 'kick') {
      needed.push([PermissionFlagsBits.BanMembers, 'Ban Members']);
    }
    if (action === 'timeout') needed.push([PermissionFlagsBits.ModerateMembers, 'Timeout Members']);
    if (action === 'quarantine') needed.push([PermissionFlagsBits.ManageRoles, 'Manage Roles']);
    return needed.filter(([flag]) => !me.permissions.has(flag)).map(([, name]) => name);
  }
}

/** When was this account created, read out of the snowflake? Null if it is not one. */
function accountCreatedMs(userId: string): number | null {
  if (!/^\d{17,20}$/.test(userId)) return null;
  return Number(BigInt(userId) >> 22n) + DISCORD_EPOCH;
}

/** Is this account less than seven days old? */
export function isNewAccount(userId: string, nowMs: number): boolean {
  const created = accountCreatedMs(userId);
  if (created === null) return false;
  return nowMs - created < SEVEN_DAYS_MS;
}
