import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type TextChannel
} from 'discord.js';
import { Command, type CommandHelpInfo } from '../core/Command.js';
import {
  DEFAULT_HONEYPOT_ACTION,
  GuildConfigStore,
  isHoneypotAction,
  type HoneypotAction
} from '../services/GuildConfigStore.js';
import { HoneypotService } from '../services/HoneypotService.js';
import { EnforcementService } from '../services/EnforcementService.js';
import { actionLabel, statsEmbed } from '../config/honeypotText.js';

/**
 * `/honeypot`: everything an admin needs to run the trap.
 *
 * Setup deliberately refuses more than it accepts: converting the wrong channel turns a
 * place people are supposed to talk into a place that removes them for talking, and that
 * is not a mistake anyone should be able to make in one command.
 */
export class HoneypotCommand extends Command {
  public readonly guildOnly = true;

  public readonly data = new SlashCommandBuilder()
    .setName('honeypot')
    .setDescription('Set up and manage the honeypot trap channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub
        .setName('setup')
        .setDescription('Create the trap channel, or convert one that already exists.')
        .addStringOption(opt =>
          opt
            .setName('action')
            .setDescription('What happens to someone the trap catches (default: kick).')
            .addChoices(
              { name: 'Kick (softban: removes them and purges 7 days of messages)', value: 'kick' },
              { name: 'Ban (permanent, purges 7 days of messages)', value: 'ban' },
              { name: 'Timeout (1 week)', value: 'timeout' },
              { name: 'Quarantine (applies a locked-down role)', value: 'quarantine' }
            )
        )
        .addChannelOption(opt =>
          opt
            .setName('channel')
            .setDescription('Convert this existing channel instead of creating a new one.')
            .addChannelTypes(ChannelType.GuildText)
        )
        .addStringOption(opt =>
          opt
            .setName('name')
            .setDescription('Name for a newly created trap channel (default: do-not-type-here).')
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('config')
        .setDescription('Change the trap settings.')
        .addStringOption(opt =>
          opt
            .setName('action')
            .setDescription('What happens to someone the trap catches.')
            .addChoices(
              { name: 'Kick (softban)', value: 'kick' },
              { name: 'Ban', value: 'ban' },
              { name: 'Timeout (1 week)', value: 'timeout' },
              { name: 'Quarantine', value: 'quarantine' }
            )
        )
        .addChannelOption(opt =>
          opt
            .setName('log-channel')
            .setDescription('Where action reports are posted. Must not be the trap itself.')
            .addChannelTypes(ChannelType.GuildText)
        )
        .addRoleOption(opt =>
          opt.setName('hide-from').setDescription('Hide the trap from this role entirely.')
        )
        .addRoleOption(opt =>
          opt.setName('show-to').setDescription('Stop hiding the trap from this role.')
        )
        .addUserOption(opt =>
          opt.setName('exempt-user').setDescription('Never act on this user.')
        )
        .addUserOption(opt =>
          opt.setName('unexempt-user').setDescription('Remove a user exemption.')
        )
        .addRoleOption(opt =>
          opt.setName('exempt-role').setDescription('Never act on members with this role.')
        )
        .addRoleOption(opt =>
          opt.setName('unexempt-role').setDescription('Remove a role exemption.')
        )
    )
    .addSubcommand(sub => sub.setName('status').setDescription('Show the current trap settings.'))
    .addSubcommand(sub => sub.setName('stats').setDescription('Show what the trap has caught.'))
    .addSubcommand(sub =>
      sub.setName('remove').setDescription('Tear the trap down and forget the settings.')
    );

  public readonly helpInfo: CommandHelpInfo = {
    name: 'honeypot',
    description: 'Set up and manage the honeypot trap channel',
    usage: '/honeypot <setup | config | status | stats | remove>',
    examples: [
      '/honeypot setup',
      '/honeypot setup action:ban name:do-not-enter',
      '/honeypot setup channel:#general-2',
      '/honeypot config log-channel:#mod-log',
      '/honeypot config exempt-role:@Moderator',
      '/honeypot stats',
      '/honeypot remove'
    ],
    category: 'Honeypot'
  };

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;

    switch (interaction.options.getSubcommand()) {
      case 'setup':
        await this.setup(interaction, guild);
        return;
      case 'config':
        await this.config(interaction, guild);
        return;
      case 'status':
        await this.status(interaction, guild);
        return;
      case 'stats':
        await this.stats(interaction, guild);
        return;
      case 'remove':
        await this.remove(interaction, guild);
        return;
    }
  }

  private async setup(interaction: ChatInputCommandInteraction, guild: Guild): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const store = GuildConfigStore.getInstance();
    if (!store) {
      await interaction.editReply('The config store is not ready. Try again in a moment.');
      return;
    }

    if (store.getGuild(guild.id)) {
      await interaction.editReply(
        'There is already a honeypot in this server. Run `/honeypot remove` first, or use `/honeypot config` to change its settings.'
      );
      return;
    }

    const actionOption = interaction.options.getString('action');
    const action: HoneypotAction = isHoneypotAction(actionOption)
      ? actionOption
      : DEFAULT_HONEYPOT_ACTION;

    const missing = EnforcementService.missingPermissionsFor(guild, action);
    if (missing.length) {
      await interaction.editReply(
        `I can't apply a **${actionLabel(action)}** without the **${missing.join(
          '**, **'
        )}** permission. Grant it and run this again.`
      );
      return;
    }

    const hideRole = await HoneypotService.ensureHideRole(guild);
    if (!hideRole) {
      await interaction.editReply(
        "I couldn't create the **Hide Honeypot** role. Check that I have **Manage Roles**, then try again."
      );
      return;
    }

    const existingChannel = interaction.options.getChannel('channel') as TextChannel | null;

    if (existingChannel) {
      const refusal = await this.refuseUnsafeConversion(guild, existingChannel);
      if (refusal) {
        await interaction.editReply(refusal);
        return;
      }

      const result = await HoneypotService.convertExisting(guild, hideRole, existingChannel, action);
      await interaction.editReply(
        result.ok
          ? `Converted <#${existingChannel.id}> into the honeypot. Anyone who posts there gets a **${actionLabel(action)}**.`
          : result.reason
      );
      return;
    }

    const name = interaction.options.getString('name') ?? 'do-not-type-here';
    const result = await HoneypotService.deployNew(guild, hideRole, name, action);
    await interaction.editReply(
      result.ok
        ? `Honeypot armed in <#${result.channel.id}>. Anyone who posts there gets a **${actionLabel(action)}**.\n\nSet a log channel with \`/honeypot config log-channel:#your-channel\` so you see who it catches.`
        : result.reason
    );
  }

  /**
   * Reasons to refuse converting a channel.
   *
   * The system and rules channels are where members are told to post, and a channel with
   * recent human conversation is one people are still using. Turning either into a trap
   * would punish members for normal behaviour.
   */
  private async refuseUnsafeConversion(
    guild: Guild,
    channel: TextChannel
  ): Promise<string | null> {
    if (HoneypotService.isProtectedChannel(guild, channel.id)) {
      return "That's this server's system or rules channel. Trapping it would remove members for posting where you told them to. Pick another channel.";
    }

    try {
      const recent = await channel.messages.fetch({ limit: 20 });
      const humanMessages = recent.filter(message => !message.author.bot);
      if (humanMessages.size > 0) {
        return `<#${channel.id}> has recent messages from real people, so it's still in use. Trapping it would remove the next person who posts. Pick an empty channel, or let me create one.`;
      }
    } catch {
      // Cannot read the history: fall through and allow it. The admin explicitly named
      // this channel, and refusing on a permissions hiccup would be more confusing.
    }
    return null;
  }

  private async config(interaction: ChatInputCommandInteraction, guild: Guild): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const store = GuildConfigStore.getInstance();
    const current = store?.getGuild(guild.id);
    if (!store || !current) {
      await interaction.editReply('There is no honeypot in this server yet. Run `/honeypot setup`.');
      return;
    }

    const changes: string[] = [];

    const actionOption = interaction.options.getString('action');
    if (isHoneypotAction(actionOption)) {
      const missing = EnforcementService.missingPermissionsFor(guild, actionOption);
      if (missing.length) {
        await interaction.editReply(
          `I can't apply a **${actionLabel(actionOption)}** without the **${missing.join(
            '**, **'
          )}** permission.`
        );
        return;
      }
      await store.patchGuild(guild.id, { action: actionOption });
      changes.push(`Action is now **${actionLabel(actionOption)}**.`);
    }

    const logChannel = interaction.options.getChannel('log-channel') as TextChannel | null;
    if (logChannel) {
      if (logChannel.id === current.channelId) {
        await interaction.editReply(
          'The log channel cannot be the trap itself. Reports name the offender, and the trap is public.'
        );
        return;
      }
      await store.patchGuild(guild.id, { logChannelId: logChannel.id });
      changes.push(`Action reports now go to <#${logChannel.id}>.`);
    }

    const hideFrom = interaction.options.getRole('hide-from');
    const showTo = interaction.options.getRole('show-to');
    if (hideFrom || showTo) {
      const hidden = new Set(current.hideFromRoleIds ?? []);
      if (hideFrom) {
        hidden.add(hideFrom.id);
        changes.push(`The trap is now hidden from **${hideFrom.name}**.`);
      }
      if (showTo) {
        hidden.delete(showTo.id);
        changes.push(`**${showTo.name}** can see the trap again.`);
      }
      await store.patchGuild(guild.id, { hideFromRoleIds: [...hidden] });
      await HoneypotService.applyHideFromRoles(guild);
    }

    const exemptUser = interaction.options.getUser('exempt-user');
    const unexemptUser = interaction.options.getUser('unexempt-user');
    if (exemptUser || unexemptUser) {
      const users = new Set(current.exemptUserIds ?? []);
      if (exemptUser) {
        users.add(exemptUser.id);
        changes.push(`**${exemptUser.tag}** is now exempt.`);
      }
      if (unexemptUser) {
        users.delete(unexemptUser.id);
        changes.push(`**${unexemptUser.tag}** is no longer exempt.`);
      }
      await store.patchGuild(guild.id, { exemptUserIds: [...users] });
    }

    const exemptRole = interaction.options.getRole('exempt-role');
    const unexemptRole = interaction.options.getRole('unexempt-role');
    if (exemptRole || unexemptRole) {
      const roles = new Set(current.exemptRoleIds ?? []);
      if (exemptRole) {
        roles.add(exemptRole.id);
        changes.push(`Members with **${exemptRole.name}** are now exempt.`);
      }
      if (unexemptRole) {
        roles.delete(unexemptRole.id);
        changes.push(`Members with **${unexemptRole.name}** are no longer exempt.`);
      }
      await store.patchGuild(guild.id, { exemptRoleIds: [...roles] });
    }

    await interaction.editReply(
      changes.length ? changes.join('\n') : 'Nothing to change. Pass at least one option.'
    );
  }

  private async status(interaction: ChatInputCommandInteraction, guild: Guild): Promise<void> {
    const config = GuildConfigStore.getInstance()?.getGuild(guild.id);
    if (!config) {
      await interaction.reply({
        content: 'There is no honeypot in this server yet. Run `/honeypot setup`.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const names = (ids: string[] | undefined, kind: 'role' | 'user'): string =>
      ids?.length
        ? ids.map(id => (kind === 'role' ? `<@&${id}>` : `<@${id}>`)).join(', ')
        : 'none';

    await interaction.reply({
      content: [
        `**Trap channel:** <#${config.channelId}>${config.createdByBot === false ? ' (converted)' : ''}`,
        `**Action:** ${actionLabel(config.action ?? DEFAULT_HONEYPOT_ACTION)}`,
        `**Log channel:** ${config.logChannelId ? `<#${config.logChannelId}>` : 'not set, reports only go to the console'}`,
        `**Hidden from roles:** ${names(config.hideFromRoleIds, 'role')}`,
        `**Exempt users:** ${names(config.exemptUserIds, 'user')}`,
        `**Exempt roles:** ${names(config.exemptRoleIds, 'role')}`
      ].join('\n'),
      flags: MessageFlags.Ephemeral
    });
  }

  private async stats(interaction: ChatInputCommandInteraction, guild: Guild): Promise<void> {
    const store = GuildConfigStore.getInstance();
    if (!store?.getGuild(guild.id)) {
      await interaction.reply({
        content: 'There is no honeypot in this server yet. Run `/honeypot setup`.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.reply({
      embeds: [
        statsEmbed({
          total: store.getCatchTotal(guild.id),
          breakdown: store.getActionBreakdown(guild.id),
          recent: store.getRecentCatches(guild.id)
        })
      ],
      flags: MessageFlags.Ephemeral
    });
  }

  private async remove(interaction: ChatInputCommandInteraction, guild: Guild): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const result = await HoneypotService.remove(guild);
    if (!result.removed) {
      await interaction.editReply('There is no honeypot in this server.');
      return;
    }

    await interaction.editReply(
      result.converted
        ? 'Honeypot removed. The channel is back to normal, minus the trap message.'
        : 'Honeypot removed. The trap channel and its role are gone.'
    );
  }
}
