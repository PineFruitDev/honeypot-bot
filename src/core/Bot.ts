import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  type Interaction,
  type Message
} from 'discord.js';
import { Command } from './Command.js';
import { CommandManager } from './CommandManager.js';
import {
  REQUIRED_INTENTS,
  assertLeastPrivilegeIntents,
  describeIntents
} from './intents.js';
import { evaluateTrapMessage, trapMessageFacts } from './TrapDetection.js';
import { Logger } from '../services/Logger.js';
import { roleHierarchyIssue, missingGuildPermissions } from '../services/BotPermissions.js';
import { GuildConfigStore } from '../services/GuildConfigStore.js';
import { EnforcementService } from '../services/EnforcementService.js';
import { HoneypotService } from '../services/HoneypotService.js';
import { BUTTON_IDS, statsEmbed } from '../config/honeypotText.js';

/**
 * Main Bot class: owns the Discord client, the command set, and the two events the trap
 * runs on: a message in the trap channel and a press on one of its buttons.
 */
export class Bot {
  private logger = new Logger({ context: 'Bot' });
  private client: Client;
  private commandManager: CommandManager;
  private intents: GatewayIntentBits[];

  constructor(
    private token: string,
    commands: Command[] = [],
    /**
     * Guilds and GuildMessages only, so the bot needs no privileged intents at all.
     *
     * The list and the reasoning behind it live in `core/intents.ts`, which also refuses
     * a privileged intent outright rather than letting one reach the gateway.
     */
    intents: readonly GatewayIntentBits[] = REQUIRED_INTENTS
  ) {
    assertLeastPrivilegeIntents(intents);
    this.intents = [...intents];
    this.client = new Client({ intents: this.intents });
    this.commandManager = new CommandManager(commands);
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    this.client.once(Events.ClientReady, () => {
      this.logger.info(`setupEventListeners - Bot logged in as ${this.client.user?.tag}`);
      // Stated at startup so an operator can confirm from the log alone that nothing
      // privileged is being requested, without opening the Developer Portal.
      this.logger.info(
        `setupEventListeners - Gateway intents: ${describeIntents(this.intents)}. No privileged intents requested.`
      );
    });

    this.client.on(Events.MessageCreate, message => {
      void this.handleMessage(message);
    });

    this.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      if (interaction.isButton()) {
        await this.handleButton(interaction);
        return;
      }
      if (interaction.isChatInputCommand()) {
        await this.handleCommand(interaction);
      }
    });

    this.client.on(Events.GuildDelete, guild => {
      if (guild.available === false) return;
      void GuildConfigStore.getInstance()?.removeGuild(guild.id).catch(() => {
        this.logger.error('Guild departure cleanup failed; retry on next startup');
      });
    });

    this.client.on(Events.Error, error => {
      this.logger.error('setupEventListeners - Discord client error:', error);
    });
  }

  /**
   * Anyone who posts in the trap channel is caught.
   *
   * Only MessageCreate is wired up. An edit is not a second offence, and the bot's own
   * deletion of a caught message must not read as one either, so neither MessageUpdate nor
   * MessageDelete has a listener.
   */
  private async handleMessage(message: Message): Promise<void> {
    try {
      const store = GuildConfigStore.getInstance();
      const verdict = evaluateTrapMessage(
        trapMessageFacts(message),
        this.client.user?.id,
        (guildId, channelId) => store?.isTrapChannel(guildId, channelId) ?? false
      );

      if (!verdict.catch) {
        if (verdict.deleteMessage) await message.delete().catch(() => {});
        // Only worth a line for the two that look like a catch and are not, so a staff
        // member asking "why did nothing happen?" finds the answer in the log.
        if (verdict.reason === 'discord-member-notice' || verdict.reason === 'posted-by-a-webhook') {
          this.logger.info(
            `handleMessage - Took no action in ${message.guildId}: ${verdict.reason}`
          );
        }
        return;
      }

      // The verdict only needs the guild's ID, which the payload always carries, but
      // enforcement needs the guild itself. Resolve it before deleting anything: a guild
      // missing from the cache during a gateway resume would otherwise lose the message and
      // the catch both, leaving no trace of either.
      const guild = message.guild;
      if (!guild) {
        this.logger.warn(
          `handleMessage - ${message.guildId} is not in the cache, leaving the message alone`
        );
        return;
      }

      // Delete first. Whatever the configured action turns out to be, the fastest way to
      // blunt a spam flood is to take the payload down immediately.
      await message.delete().catch(() => {});

      await EnforcementService.handleCatch({
        guild,
        user: message.author,
        member: message.member,
        trigger: 'sent a message in the honeypot channel',
        source: 'message'
      });
      await EnforcementService.refreshTrap(guild);
    } catch (error) {
      this.logger.error('handleMessage - Failed to process a trap message:', error);
    }
  }

  private async handleButton(interaction: Interaction): Promise<void> {
    if (!interaction.isButton() || !interaction.guild) return;
    const store = GuildConfigStore.getInstance();
    const config = store?.getGuild(interaction.guild.id);
    if (!store || !config) return;

    try {
      switch (interaction.customId) {
        case BUTTON_IDS.hide:
          await this.handleHide(interaction);
          return;

        case BUTTON_IDS.stats: {
          const guildId = interaction.guild.id;
          await interaction.reply({
            embeds: [
              statsEmbed({
                total: store.getCatchTotal(guildId),
                breakdown: store.getActionBreakdown(guildId),
                recent: store.getRecentCatches(guildId)
              })
            ],
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        case BUTTON_IDS.decoyLeft:
        case BUTTON_IDS.decoyRight: {
          // Acknowledge before acting: the action can take a few seconds, and an
          // unacknowledged interaction times out at three.
          await interaction
            .reply({
              content: 'That was the button you were told not to press.',
              flags: MessageFlags.Ephemeral
            })
            .catch(() => {});

          const guild = interaction.guild;
          await EnforcementService.handleCatch({
            guild,
            user: interaction.user,
            // The interaction payload carries the full member, roles included, so this
            // works without the Server Members intent.
            member: interaction.member instanceof GuildMember ? interaction.member : null,
            trigger: 'pressed a trap button',
            source: 'button',
            // The buttons always kick, whatever the message path is configured to do. The
            // escalation rule still upgrades a young account to a ban.
            requestedAction: 'kick'
          });
          await EnforcementService.refreshTrap(guild);
          return;
        }
      }
    } catch (error) {
      this.logger.error(`handleButton - Failed handling ${interaction.customId}:`, error);
    }
  }

  /** Give the presser the hide role, so the trap disappears from their channel list. */
  private async handleHide(interaction: Interaction): Promise<void> {
    if (!interaction.isButton() || !interaction.guild) return;
    const config = GuildConfigStore.getInstance()?.getGuild(interaction.guild.id);
    if (!config?.hideRoleId) return;

    const guild = interaction.guild;
    const role = guild.roles.cache.get(config.hideRoleId);
    const member = interaction.member instanceof GuildMember ? interaction.member : null;
    if (!role) {
      await interaction.reply({
        content:
          "I couldn't hide the channel: the **Hide Honeypot** role is gone. Ask an admin to run `/honeypot setup` again.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    if (!member) {
      await interaction.reply({
        content: "I couldn't read your server profile, so I can't hide the channel. Try again in a moment.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    // Checked before the REST call, so a member who presses this gets told what is actually
    // wrong instead of a generic "check my Manage Roles permission" that may be a red herring.
    const missing = missingGuildPermissions(guild, [
      [PermissionFlagsBits.ManageRoles, 'Manage Roles']
    ]);
    const blocked = missing.length
      ? `I do not have the **${missing.join('**, **')}** permission in this server.`
      : roleHierarchyIssue(guild, role);
    if (blocked) {
      this.logger.warn(`handleHide - Cannot hide for ${interaction.user.id} in ${guild.id}: ${blocked}`);
      await interaction.reply({
        content: `I couldn't hide the channel. ${blocked} Ask an admin to sort that out.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    try {
      await member.roles.add(role, 'Honeypot: member chose to hide the trap channel');
      await interaction.reply({
        content: "Hidden. You won't see that channel again.",
        flags: MessageFlags.Ephemeral
      });
    } catch (error) {
      this.logger.error(`handleHide - Could not add the hide role for ${interaction.user.id}:`, error);
      await interaction
        .reply({
          content:
            "I couldn't hide the channel. Ask an admin to check my **Manage Roles** permission and that my role sits above **Hide Honeypot**.",
          flags: MessageFlags.Ephemeral
        })
        .catch(() => {});
    }
  }

  private async handleCommand(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;

    const command = this.commandManager.getCommand(interaction.commandName);
    if (!command) {
      this.logger.warn(`handleCommand - Unknown command: ${interaction.commandName}`);
      return;
    }

    try {
      const validation = await command.validate(interaction);
      if (!validation.valid) {
        this.logger.warn(
          `handleCommand - Validation failed for ${interaction.commandName}: ${validation.reason}`
        );
        await interaction.reply({
          content: `❌ ${validation.reason}`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      await command.execute(interaction, process.env);
      this.logger.info(
        `handleCommand - Executed ${interaction.commandName} for ${interaction.user.tag}`
      );
    } catch (error) {
      this.logger.error(`handleCommand - Error executing ${interaction.commandName}:`, error);

      const errorMessage = '❌ An error occurred while running that command.';
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: errorMessage, flags: MessageFlags.Ephemeral }).catch(() => {});
      } else {
        await interaction.reply({ content: errorMessage, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  }

  /**
   * Re-apply the trap's channel state on boot.
   *
   * A server can change while the bot is offline: someone edits an overwrite, or deletes
   * the trap channel outright. Reconciling at startup means the trap is either correct or
   * cleanly forgotten, never half configured.
   */
  public async reconcileOnBoot(): Promise<void> {
    const store = GuildConfigStore.getInstance();
    if (!store) return;

    for (const { guildId, config } of store.getAllGuilds()) {
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) { await store.removeGuild(guildId); continue; }
      if (!guild.available) continue;

      const channel = guild.channels.cache.get(config.channelId);
      if (!channel || channel.type !== ChannelType.GuildText) {
        this.logger.warn(
          `reconcileOnBoot - Trap channel ${config.channelId} is gone in ${guildId}, clearing the config`
        );
        await store.removeGuild(guildId);
        continue;
      }
      await HoneypotService.applyHideFromRoles(guild);
    }
  }

  public async start(): Promise<void> {
    try {
      await this.client.login(this.token);
    } catch (error) {
      this.logger.error('start - Failed to start bot:', error);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.logger.info('stop - Shutting down bot...');
    await this.client.destroy();
    await GuildConfigStore.getInstance()?.drain();
  }

  public getCommandManager(): CommandManager {
    return this.commandManager;
  }

  public getClient(): Client {
    return this.client;
  }
}
