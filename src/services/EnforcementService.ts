import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type Role,
  type TextChannel,
  type User
} from 'discord.js';
import { DiscordApi, type ActionResult, type SoftbanBanState } from './DiscordApi.js';
import {
  DEFAULT_HONEYPOT_ACTION,
  GuildConfigStore,
  type HoneypotAction
} from './GuildConfigStore.js';
import { HoneypotService } from './HoneypotService.js';
import { actionBlockedReason, missingGuildPermissions, permissionsForAction, roleHierarchyIssue } from './BotPermissions.js';
import { Logger, newCorrelationId } from './Logger.js';
import { MAX_RECOVERY_ATTEMPTS, PendingActionStore } from './PendingActionStore.js';
import {
  QUARANTINE_ROLE_NAME,
  actionReportEmbed,
  offenderDmEmbed,
  operationalAlertEmbed
} from '../config/honeypotText.js';

/** Seven days, the window for both the timeout length and the young-account escalation. */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Discord's epoch, for reading an account's creation time out of its snowflake. */
const DISCORD_EPOCH = 1420070400000;

/** How much recent history a ban or softban purges, in seconds. Discord's maximum. */
const PURGE_SECONDS = 604800;

export interface CatchOutcome {
  blockedReason?: string;
  action: HoneypotAction | 'none';
  escalated: boolean;
  result: ActionResult;
  skipped: boolean;
  /** Softban only: whether the member ended up unbanned, still banned, or unverifiable. */
  banState?: SoftbanBanState;
  /** Ties this catch to its log lines, and to the message shown to a user if one is shown. */
  correlationId: string;
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
    /** Supplied by the caller so the triggering event and the action share one ID. */
    correlationId?: string;
  }): Promise<CatchOutcome> {
    const { guild, user, member, trigger, source } = opts;
    const correlationId = opts.correlationId ?? newCorrelationId();
    const log = this.logger.child({ correlationId, guildId: guild.id, userId: user.id });
    const store = GuildConfigStore.getInstance();
    const config = store?.getGuild(guild.id);
    if (!store || !config) {
      return { action: 'none', escalated: false, result: 'error', skipped: true, correlationId };
    }

    if (await this.isExempt(guild, user, member, config.exemptUserIds, config.exemptRoleIds)) {
      log.info('handleCatch - Caught member is exempt, taking no action');
      return {
        action: 'none',
        escalated: false,
        result: 'success',
        skipped: true,
        correlationId
      };
    }

    // A throwaway account that trips the trap is escalated to a real ban regardless of the
    // configured action. Spam rings cycle fresh accounts, and a kick just invites the next one.
    const escalated = source === 'message' && isNewAccount(user.id, Date.now());
    const requested = opts.requestedAction ?? config.action ?? DEFAULT_HONEYPOT_ACTION;
    const action: HoneypotAction = escalated ? 'ban' : requested;

    const reason = `Honeypot: ${trigger}. Automatic ${action}${
      escalated ? ', escalated because the account is under 7 days old' : ''
    }.`;

    let result: ActionResult = 'error';
    let finalAction: HoneypotAction | 'none' = action;
    let unbanFailed = false;
    let banState: SoftbanBanState | undefined;

    const blockedReason = actionBlockedReason(guild, action, member);
    if (blockedReason) { result = 'missing_perms'; finalAction = 'none'; }
    if (!blockedReason) {
      try {
        switch (action) {
          case 'ban':
            result = await DiscordApi.banMember(guild.id, user.id, reason, PURGE_SECONDS);
            break;

          case 'kick': {
            // A kick is carried out as a softban: ban with a 7 day purge, then unban. The net
            // effect is a kick, but it also wipes the spam from every channel in one call,
            // which a plain kick cannot do. If the ban fails there is nothing to undo.
            //
            // The intent is journalled to disk *before* the ban, because the gap between the
            // two halves is the one place a crash leaves a real person banned when a kick was
            // intended. Whatever is still in the journal at startup is an unban the previous
            // process owed somebody, and recoverPendingSoftbans pays it.
            const outcome = await this.runSoftban({ guild, user, reason, log });
            result = outcome.result;
            unbanFailed = outcome.unbanFailed;
            banState = outcome.banState;
            break;
          }

          case 'timeout':
            result = await this.timeoutMember(member, reason);
            break;

          case 'quarantine':
            result = await this.quarantineMember(guild, member, reason);
            break;
        }
      } catch (error) {
        log.error('handleCatch - Action threw', error, { action });
        result = 'error';
      }

    }

    // An action that did not land is recorded and reported as 'none', whichever action it
    // was. CatchRecord's contract is "what actually ran", so a history saying 'ban' for a
    // ban Discord refused makes the /honeypot stats breakdown count removals that never
    // happened, and puts "Banned, messages from the last 7 days purged" in the action
    // report immediately above "Failed".
    if (result !== 'success') finalAction = 'none';

    if (result === 'missing_perms' || result === 'error') {
      // Say this loudly in the console as well as the log channel. The permission that
      // blocks a ban often blocks posting the report too, so the report alone can vanish.
      log.error(
        'handleCatch - Action FAILED, most likely a missing permission or my role sitting below theirs',
        undefined,
        { action, result, escalated }
      );
    }

    let total = store.getCatchTotal(guild.id);
    try { total = await store.recordCatch(guild.id, {
      userId: user.id,
      userTag: user.tag,
      action: finalAction,
      escalated,
      source,
      caughtAt: new Date().toISOString()
    }); } catch (error) { log.error('handleCatch - Action completed but catch history could not be saved', error); }
    log.info('handleCatch - Caught and acted on a member', {
      action: finalAction,
      result,
      escalated,
      source,
      total
    });

    // A courtesy, and best effort by design. Opening a DM channel with someone who has
    // just been banned usually fails unless one already existed, which for a throwaway
    // spam account it will not. Worth attempting for the humans who trip this by accident.
    if (!blockedReason && result === 'success') await this.dmOffender(user, guild, action, trigger, escalated, banState);

    await this.postReport({
      guild,
      user,
      action: finalAction,
      trigger,
      escalated,
      failed: result === 'missing_perms' || result === 'error',
      unbanFailed,
      banState,
      blockedReason
    });

    return { action: finalAction, escalated, result, skipped: false, banState, correlationId, blockedReason: blockedReason ?? undefined };
  }

  /**
   * Ban, journal, unban.
   *
   * Split out of handleCatch because the ordering is the correctness argument: the record
   * exists before the ban, moves to `unban_pending` only once the ban is known to have
   * landed, and is removed only once the member is known not to be banned. A failure at any
   * step leaves a record behind on purpose.
   */
  private static async runSoftban(opts: {
    guild: Guild;
    user: User;
    reason: string;
    log: Logger;
  }): Promise<{ result: ActionResult; unbanFailed: boolean; banState?: SoftbanBanState }> {
    const { guild, user, reason, log } = opts;
    const journal = PendingActionStore.getInstance();
    if (!journal || journal.degraded) {
      log.error('runSoftban - Refusing a softban without a healthy recovery journal');
      return { result: 'error', unbanFailed: false };
    }
    if (journal.listForGuild(guild.id).some(record => record.userId === user.id)) {
      log.warn('runSoftban - An earlier softban still needs recovery');
      return { result: 'error', unbanFailed: true, banState: 'unknown' };
    }
    if (await DiscordApi.isMemberBanned(guild.id, user.id) !== false) {
      log.warn('runSoftban - Cannot prove this member is currently unbanned; refusing to replace a possible staff ban');
      return { result: 'error', unbanFailed: false };
    }
    const entry = await journal?.open({
      guildId: guild.id,
      userId: user.id,
      userTag: user.tag
    });

    if (!entry?.persisted) {
      log.error('runSoftban - Refusing a softban whose recovery intent could not be saved');
      return { result: 'error', unbanFailed: false };
    }

    const result = await DiscordApi.banMember(
      guild.id,
      user.id,
      `[honeypot:${entry.id}] ${reason} [softban: kick and purge]`,
      PURGE_SECONDS
    );

    if (result !== 'success') {
      if (result === 'missing_perms') {
        await journal.resolve(entry.id);
        return { result, unbanFailed: false };
      }
      // Transport errors can happen after Discord accepted the ban. Retain the intent.
      await journal.setPhase(entry.id, 'unresolved', 'Ban request outcome is uncertain');
      return { result, unbanFailed: true, banState: 'unknown' };
    }

    if (entry) await journal?.setPhase(entry.id, 'unban_pending');

    const unban = await DiscordApi.softbanUnban(guild.id, user.id);
    if (!unban.unbanFailed) {
      if (entry) await journal?.resolve(entry.id);
      return { result, unbanFailed: false, banState: unban.banState };
    }

    if (entry) await journal?.setPhase(entry.id, 'unresolved', unban.detail, unban.retryAt);
    log.error(
      'runSoftban - Softban unban FAILED, the member may still be banned though the configured action was kick',
      undefined,
      { action: 'kick', banState: unban.banState, detail: unban.detail }
    );
    return { result, unbanFailed: true, banState: unban.banState };
  }

  /**
   * Finish softbans a previous process did not.
   *
   * Called once per guild at startup, inside that guild's own error boundary, so a server
   * the bot can no longer act in cannot stop the others from being repaired.
   */
  public static async recoverPendingSoftbans(guild: Guild): Promise<void> {
    const journal = PendingActionStore.getInstance();
    if (!journal || journal.degraded) return;

    const pending = journal.listForGuild(guild.id);
    if (!pending.length) return;

    const log = this.logger.child({ guildId: guild.id, action: 'softban_recovery' });
    log.warn('recoverPendingSoftbans - Found softbans left half done by a previous run', {
      pending: pending.length
    });

    for (const record of pending) {
      if (record.retryAt && record.retryAt > Date.now()) continue;
      const recordLog = log.child({ correlationId: record.id, userId: record.userId });

      // A record that has used its budget is left exactly as it is. Retrying a ban lookup
      // and an unban on every boot forever costs rate limit budget to learn nothing, and
      // the record itself is already the thing staff need.
      if (record.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
        recordLog.warn(
          'recoverPendingSoftbans - Record has exhausted automatic recovery, leaving it for staff',
          { recoveryAttempts: record.recoveryAttempts, detail: record.detail }
        );
        continue;
      }

      try {
        const banned = await DiscordApi.isMemberBanned(guild.id, record.userId);

        // A crash in 'ban_pending' may well have landed before dying; either way the only
        // question that matters is whether a ban is there now.
        if (banned === false) {
          await journal.resolve(record.id);
          recordLog.info('recoverPendingSoftbans - No ban remains, nothing was owed');
          continue;
        }

        if (banned === null) {
          await journal.noteRecoveryAttempt(record.id, 'ban state could not be read');
          recordLog.error(
            'recoverPendingSoftbans - Could not read the ban state, leaving the record for staff',
            undefined,
            { recoveryAttempts: record.recoveryAttempts }
          );
          await this.alertPendingSoftban(guild, record.userTag, record.userId, 'unknown');
          continue;
        }

        const reason = await DiscordApi.banReason(guild.id, record.userId);
        if (!reason?.startsWith(`[honeypot:${record.id}] `)) {
          await journal.noteRecoveryAttempt(record.id, 'Current ban cannot be attributed to this softban; staff review required');
          await this.alertPendingSoftban(guild, record.userTag, record.userId, 'unknown');
          continue;
        }

        const unban = await DiscordApi.softbanUnban(guild.id, record.userId);
        if (!unban.unbanFailed) {
          await journal.resolve(record.id);
          recordLog.info('recoverPendingSoftbans - Lifted a leftover softban ban');
          await this.alertStaff(guild, {
            title: 'recovered a leftover softban',
            description: `A kick from a previous run left **${record.userTag}** (\`${record.userId}\`) banned. The ban has now been lifted.`
          });
          continue;
        }

        await journal.setPhase(record.id, 'unresolved', unban.detail, unban.retryAt);
        await journal.noteRecoveryAttempt(record.id, unban.detail);
        recordLog.error('recoverPendingSoftbans - Could not lift a leftover ban', undefined, {
          banState: unban.banState,
          detail: unban.detail,
          recoveryAttempts: record.recoveryAttempts
        });
        // Bounded by the attempt budget above, so this is at most a handful of alerts per
        // stuck record rather than one on every boot forever.
        await this.alertPendingSoftban(guild, record.userTag, record.userId, unban.banState);
      } catch (error) {
        recordLog.error('recoverPendingSoftbans - Recovery threw, leaving the record', error);
      }
    }
  }

  private static async alertPendingSoftban(
    guild: Guild,
    userTag: string,
    userId: string,
    banState: SoftbanBanState
  ): Promise<void> {
    await this.alertStaff(guild, {
      title: 'a softban needs a human',
      description:
        banState === 'unknown'
          ? `A kick of **${userTag}** (\`${userId}\`) did not finish and I could **not verify** whether a ban remains. Check Server Settings > Bans and lift it if it is there.`
          : `A kick of **${userTag}** (\`${userId}\`) left a ban in place that I could not lift. Please lift it manually in Server Settings > Bans.`
    });
  }

  /**
   * Tell staff about something the bot could not finish.
   *
   * Uses the same log channel as the action report, and the same refusal to post anything
   * naming a member into the trap channel itself.
   */
  public static async alertStaff(
    guild: Guild,
    opts: { title: string; description: string }
  ): Promise<void> {
    const channel = this.resolveLogChannel(guild);
    if (!channel) return;
    try {
      await channel.send({ embeds: [operationalAlertEmbed(opts)] });
    } catch (error) {
      this.logger.error('alertStaff - Could not post an operational alert', error, {
        guildId: guild.id
      });
    }
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
      if (!resolved) return true;
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
    const hierarchy = roleHierarchyIssue(guild, role);
    if (hierarchy) return 'missing_perms';

    try {
      const updated = await member.roles.add(role, reason);
      const channels = [...guild.channels.cache.values()];
      if (!channels.length || channels.some(channel => {
        const effective = channel.permissionsFor(updated);
        return !effective || effective.has(PermissionFlagsBits.ViewChannel);
      })) {
        this.logger.error('quarantineMember - Role applied but some channels remain accessible; staff action required');
        return 'error';
      }
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
      if (cached) {
        if (cached.permissions.bitfield !== 0n || cached.managed) return null;
        await this.lockChannelsForRole(guild, cached);
        return cached;
      }
    }

    // A matching role name is not proof that this bot owns that role.

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
    escalated: boolean,
    banState?: SoftbanBanState
  ): Promise<void> {
    try {
      await user.send({
        embeds: [offenderDmEmbed({ action, guildName: guild.name, trigger, escalated, banState })]
      });
    } catch {
      // Closed DMs are the norm for the accounts this catches. Never load bearing.
    }
  }

  /**
   * The guild's log channel, or null when there is nowhere safe to post.
   *
   * Refuses the trap channel itself: anything posted here names a member, and the trap is
   * a channel everyone can read.
   */
  private static resolveLogChannel(guild: Guild): TextChannel | null {
    const config = GuildConfigStore.getInstance()?.getGuild(guild.id);
    if (!config?.logChannelId) return null;
    if (config.logChannelId === config.channelId) {
      this.logger.warn(
        'resolveLogChannel - The configured log channel is the trap itself, refusing to name a member publicly',
        { guildId: guild.id }
      );
      return null;
    }
    const channel = guild.channels.cache.get(config.logChannelId);
    if (!channel || channel.type !== ChannelType.GuildText) return null;
    return channel as TextChannel;
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
    banState?: SoftbanBanState;
    blockedReason?: string | null;
  }): Promise<void> {
    const channel = this.resolveLogChannel(opts.guild);
    if (!channel) return;

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
            unbanFailed: opts.unbanFailed,
            banState: opts.banState,
            blockedReason: opts.blockedReason ?? undefined
          })
        ]
      });
    } catch (error) {
      this.logger.error('postReport - Could not post the action report', error, {
        guildId: opts.guild.id,
        channelId: channel.id
      });
    }
  }

  /** Re-sticky the trap after a catch so it stays visible above the mess. */
  public static async refreshTrap(guild: Guild): Promise<void> {
    await HoneypotService.refreshSticky(guild);
  }

  /** Does the bot hold the permissions the configured action needs? Used by setup. */
  public static missingPermissionsFor(guild: Guild, action: HoneypotAction): string[] {
    return missingGuildPermissions(guild, permissionsForAction(action));
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
