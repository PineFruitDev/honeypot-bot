import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type Role,
  type TextChannel
} from 'discord.js';
import { GuildConfigStore, type GuildConfig, type HoneypotAction } from './GuildConfigStore.js';
import { Logger } from './Logger.js';
import { HIDE_ROLE_NAME, TRAP_TOPIC, trapButtons, trapEmbed } from '../config/honeypotText.js';

/** A provisioning outcome the caller maps onto its own reply. */
export type ProvisionResult =
  | { ok: true; channel: TextChannel; converted: boolean }
  | { ok: false; reason: string };

/**
 * Owns the trap itself: creating or converting the channel, the permission overwrites that
 * make it visible-but-hideable, the sticky message, and tearing all of it back down.
 *
 * Enforcement lives in EnforcementService. This module never decides what happens to a
 * person, only what the channel looks like.
 */
export class HoneypotService {
  private static logger = new Logger({ context: 'HoneypotService' });

  /**
   * Find or create the "Hide Honeypot" role.
   *
   * Hiding the channel is a role rather than a per-user permission overwrite on purpose:
   * a channel tops out at 500 overwrites, so a per-user hide would quietly stop working
   * on a busy server. One role costs one overwrite no matter how many people use it.
   */
  public static async ensureHideRole(guild: Guild): Promise<Role | null> {
    // Role names are not ownership: never hand out an unrelated role with this name.

    try {
      return await guild.roles.create({
        name: HIDE_ROLE_NAME,
        permissions: [],
        hoist: false,
        mentionable: false,
        reason: 'Honeypot setup: role that hides the trap channel'
      });
    } catch (error) {
      this.logger.error(`ensureHideRole - Could not create the role in ${guild.id}:`, error);
      return null;
    }
  }

  /**
   * Delete a hide role that a setup created and then could not use.
   *
   * `ensureHideRole` creates a fresh role every time it runs, deliberately: a role that
   * merely shares the name is not proof the bot owns it. The cost is that a setup which
   * fails after the role exists leaves it behind, and because nothing reuses it, a second
   * attempt makes a second one. An admin trying a few candidate channels ends up with a
   * role list full of identical **Hide Honeypot** entries, none of which hides anything,
   * and no way to tell which one the trap would have used.
   *
   * Best effort, and it refuses to touch the role a trap is actually using: this only ever
   * cleans up after a setup that never armed.
   */
  public static async discardHideRole(guild: Guild, role: Role): Promise<void> {
    if (GuildConfigStore.getInstance()?.getGuild(guild.id)?.hideRoleId === role.id) return;
    try {
      await role.delete('Honeypot setup failed, discarding the unused hide role');
    } catch (error) {
      this.logger.error(`discardHideRole - Could not delete the unused role in ${guild.id}:`, error);
    }
  }

  /**
   * The trap's base overwrites: everyone can see it and read it, and Send Messages is
   * deliberately left alone so a spam bot walks straight in. Members holding the hide role
   * cannot see it at all.
   */
  private static baseOverwrites(guild: Guild, hideRoleId: string) {
    return [
      {
        id: guild.roles.everyone.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
      },
      { id: hideRoleId, deny: [PermissionFlagsBits.ViewChannel] }
    ];
  }

  /** Create a brand new trap channel, post the trap message, and store the config. */
  public static async deployNew(
    guild: Guild,
    hideRole: Role,
    channelName: string,
    action: HoneypotAction
  ): Promise<ProvisionResult> {
    let channel: TextChannel;
    try {
      channel = await guild.channels.create({
        name: sanitizeChannelName(channelName),
        type: ChannelType.GuildText,
        topic: TRAP_TOPIC,
        permissionOverwrites: this.baseOverwrites(guild, hideRole.id),
        reason: 'Honeypot setup'
      });
    } catch (error) {
      this.logger.error(`deployNew - Could not create the channel in ${guild.id}:`, error);
      return {
        ok: false,
        reason:
          "I couldn't create the channel. Check that I have **Manage Channels**, then try again."
      };
    }

    const messageId = await this.postSticky(channel, 0);
    if (!messageId) return { ok: false, reason: 'I could not post the trap warning, so the trap was not armed. Check Send Messages and Embed Links.' };
    await GuildConfigStore.getInstance()?.setTrap(guild.id, {
      channelId: channel.id,
      hideRoleId: hideRole.id,
      createdByBot: true,
      messageId,
      action
    });
    await this.applyHideFromRoles(guild);
    return { ok: true, channel, converted: false };
  }

  /**
   * Convert a channel that already exists into the trap: rewrite its overwrites, set the
   * topic, post the trap message. The channel is not deleted on removal, only un-converted.
   */
  public static async convertExisting(
    guild: Guild,
    hideRole: Role,
    channel: TextChannel,
    action: HoneypotAction
  ): Promise<ProvisionResult> {
    // Read before the write below replaces it. The topic is the admin's own description of
    // a channel the bot is only borrowing, and this is the last moment it can be recovered:
    // nothing else in Discord keeps the old value.
    const previousTopic = channel.topic ?? undefined;

    try {
      await channel.permissionOverwrites.edit(
        guild.roles.everyone,
        { ViewChannel: true, ReadMessageHistory: true },
        { reason: 'Honeypot setup' }
      );
      await channel.permissionOverwrites.edit(
        hideRole,
        { ViewChannel: false },
        { reason: 'Honeypot setup' }
      );
      await channel.setTopic(TRAP_TOPIC, 'Honeypot setup');
    } catch (error) {
      this.logger.error(`convertExisting - Could not convert ${channel.id}:`, error);
      return {
        ok: false,
        reason:
          "I couldn't update that channel. Check that I have **Manage Channels** on it, then try again."
      };
    }

    const messageId = await this.postSticky(channel, 0);
    if (!messageId) return { ok: false, reason: 'I could not post the trap warning, so the trap was not armed. Check Send Messages and Embed Links.' };
    await GuildConfigStore.getInstance()?.setTrap(guild.id, {
      channelId: channel.id,
      hideRoleId: hideRole.id,
      createdByBot: false,
      messageId,
      action,
      previousTopic
    });
    await this.applyHideFromRoles(guild);
    return { ok: true, channel, converted: true };
  }

  /**
   * Channels that must never become the trap.
   *
   * The system and rules channels are where Discord itself and new members post, so
   * trapping either would remove people for doing exactly what the server asked them to do.
   */
  public static isProtectedChannel(guild: Guild, channelId: string): boolean {
    return channelId === guild.systemChannelId || channelId === guild.rulesChannelId || channelId === guild.safetyAlertsChannelId;
  }

  /** Post the trap message and return its ID. */
  private static async postSticky(
    channel: TextChannel,
    caughtCount: number
  ): Promise<string | undefined> {
    try {
      const message = await channel.send({
        embeds: [trapEmbed()],
        components: [trapButtons(caughtCount)]
      });
      return message.id;
    } catch (error) {
      this.logger.error(`postSticky - Could not post the trap message in ${channel.id}:`, error);
      return undefined;
    }
  }

  /**
   * Re-post the trap after a catch so it stays the newest message in the channel, with the
   * counter updated. Without this the trap scrolls out of view behind the spam it caught.
   *
   * Best effort throughout: a failure here must never undo enforcement that already ran.
   */
  public static async refreshSticky(guild: Guild): Promise<void> {
    const store = GuildConfigStore.getInstance();
    const config = store?.getGuild(guild.id);
    if (!store || !config) return;

    const channel = guild.channels.cache.get(config.channelId);
    if (!channel || channel.type !== ChannelType.GuildText) return;

    const previousId = config.messageId;
    const newId = await this.postSticky(channel, store.getCatchTotal(guild.id));
    if (!newId) return; // Keep the previous warning and binding when replacement fails.
    await store.setStickyMessage(guild.id, newId);

    if (previousId) {
      try {
        await channel.messages.delete(previousId);
      } catch {
        // Already gone, or someone deleted it by hand. Nothing to repair.
      }
    }
  }

  /**
   * Apply the configured "hide from these roles" list as View-deny overwrites on the trap,
   * and clear the ones the bot previously added that are no longer on the list.
   *
   * Cleanup is driven by what the bot recorded writing, never by scanning the channel for
   * View-denies. A converted channel can arrive with the admin's own overwrites already on
   * it, and "delete every View-deny I don't currently want" would erase those on the next
   * boot. The bot only removes what it put there.
   *
   * Fails safe in both directions: a failed edit leaves the trap more hidden than intended
   * rather than exposed, and a failed cleanup is retried on the next run because the role
   * stays on the applied list.
   */
  public static async applyHideFromRoles(guild: Guild): Promise<void> {
    const store = GuildConfigStore.getInstance();
    const config = store?.getGuild(guild.id);
    if (!store || !config) return;

    const channel = guild.channels.cache.get(config.channelId);
    if (!channel || channel.type !== ChannelType.GuildText) return;

    // The trap's own overwrites are owned by provisioning; never touch them here, or a
    // re-sync would strip the channel's base visibility.
    const reserved = new Set([guild.roles.everyone.id, config.hideRoleId].filter(Boolean));
    const wanted = (config.hideFromRoleIds ?? []).filter(id => !reserved.has(id));
    const applied = (config.appliedHideRoleIds ?? []).filter(id => !reserved.has(id));

    const stillApplied = new Set(applied);

    for (const roleId of wanted) {
      try {
        await channel.permissionOverwrites.edit(
          roleId,
          { ViewChannel: false },
          { reason: 'Honeypot: hide from role' }
        );
        stillApplied.add(roleId);
      } catch (error) {
        this.logger.error(`applyHideFromRoles - Could not hide from role ${roleId}:`, error);
      }
    }

    // Clear only visibility for roles the admin has dropped; other permission bits
    // may belong to the admin and must survive.
    for (const roleId of applied) {
      if (wanted.includes(roleId)) continue;
      try {
        await channel.permissionOverwrites.edit(
          roleId,
          { ViewChannel: null },
          { reason: 'Honeypot: no longer hidden from role' }
        );
        stillApplied.delete(roleId);
      } catch (error) {
        this.logger.error(`applyHideFromRoles - Could not clear overwrite ${roleId}:`, error);
      }
    }

    await store.patchGuild(guild.id, { appliedHideRoleIds: [...stillApplied] });
  }

  /**
   * Give back the visibility the per-role hides took away.
   *
   * `appliedHideRoleIds` is the bot's own record of the View-denies it wrote, and it is
   * deleted along with the rest of the config on removal. So this is the last moment those
   * overwrites can be identified at all: anything left behind here stays on the channel
   * forever, on a channel the admin has just been told is back to normal, with nothing left
   * anywhere that knows the bot put it there.
   *
   * Clears only the visibility bit. `applyHideFromRoles` writes with an edit, which merges
   * into whatever the admin already had for that role on that channel, so deleting the whole
   * overwrite would take their settings with it.
   *
   * Best effort per role: a role the bot can no longer edit must not stop the rest of the
   * un-conversion.
   */
  private static async clearHideFromRoleOverwrites(
    guild: Guild,
    channel: TextChannel,
    config: GuildConfig
  ): Promise<void> {
    // Provisioning owns these two, and the un-conversion below deals with them itself.
    const reserved = new Set([guild.roles.everyone.id, config.hideRoleId].filter(Boolean));

    for (const roleId of config.appliedHideRoleIds ?? []) {
      if (reserved.has(roleId)) continue;
      try {
        await channel.permissionOverwrites.edit(
          roleId,
          { ViewChannel: null },
          { reason: 'Honeypot removed' }
        );
      } catch (error) {
        this.logger.error(
          `clearHideFromRoleOverwrites - Could not restore visibility for ${roleId} in ${channel.id}:`,
          error
        );
      }
    }
  }

  /**
   * Tear the trap down: delete the channel if the bot made it, or un-convert one it
   * adopted. The stored config and the hide role go last and best effort, so a leftover
   * Discord artifact can never wedge the config into an unusable state.
   *
   * Un-converting undoes every overwrite the bot wrote on that channel, the per-role hides
   * included, and restores the topic conversion replaced. "Back to normal" is what the admin
   * is told, so it has to be true for the roles the trap was hidden from as much as for
   * @everyone.
   *
   * The config this reads is deleted a few lines later, so neither is recoverable afterwards:
   * a topic not put back here is gone, and the channel keeps the empty description forever
   * with nothing left anywhere that knows what used to be there.
   */
  public static async remove(guild: Guild): Promise<{ removed: boolean; converted: boolean }> {
    const store = GuildConfigStore.getInstance();
    const config = store?.getGuild(guild.id);
    if (!store || !config) return { removed: false, converted: false };

    // createdByBot === false marks an explicitly converted channel. Older records with the
    // field absent were all bot-created, so they take the delete path.
    const converted = config.createdByBot === false;
    const channel = guild.channels.cache.get(config.channelId);

    if (channel && channel.type === ChannelType.GuildText) {
      if (converted) {
        try {
          if (config.messageId) await channel.messages.delete(config.messageId).catch(() => {});
          // Before the config that records them is thrown away.
          await this.clearHideFromRoleOverwrites(guild, channel, config);
          await channel.permissionOverwrites.delete(
            guild.roles.everyone,
            'Honeypot removed'
          );
          if (config.hideRoleId) {
            await channel.permissionOverwrites
              .delete(config.hideRoleId, 'Honeypot removed')
              .catch(() => {});
          }
          // A channel that genuinely had no topic is recorded as having none, so it gets
          // none back rather than an empty string.
          await channel.setTopic(config.previousTopic ?? null, 'Honeypot removed');
        } catch (error) {
          this.logger.error(`remove - Could not fully un-convert ${channel.id}:`, error);
        }
      } else {
        try {
          await channel.delete('Honeypot removed');
        } catch (error) {
          this.logger.error(`remove - Could not delete ${channel.id}:`, error);
        }
      }
    }

    // Delete the hide role too, so the next setup does not reuse a stale role and re-hide
    // everyone who opted out of the previous trap.
    if (config.hideRoleId) {
      const role = guild.roles.cache.get(config.hideRoleId);
      if (role) await role.delete('Honeypot removed').catch(() => {});
    }

    await store.removeGuild(guild.id);
    return { removed: true, converted };
  }
}

/**
 * Discord lowercases channel names and replaces spaces with hyphens anyway. Doing it here
 * means the name stored in config matches the name people see.
 */
export function sanitizeChannelName(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]/g, '')
    .slice(0, 100);
  return cleaned || 'do-not-type-here';
}
