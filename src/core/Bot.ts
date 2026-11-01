import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  GuildMember,
  MessageFlags,
  type Interaction,
  type Message
} from 'discord.js';
import { Command } from './Command.js';
import { CommandManager } from './CommandManager.js';
import { evaluateTrapMessage, trapMessageFacts } from './TrapDetection.js';
import { Logger } from '../services/Logger.js';
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

  constructor(
    private token: string,
    commands: Command[] = [],
    /**
     * Guilds and GuildMessages only, so the bot needs no privileged intents at all.
     *
     * Message Content is not requested because the trap only needs to know that someone
     * posted, never what they wrote. Server Members is not requested either: the member
     * object arrives inside the message and interaction payloads, which is everywhere this
     * bot looks at roles.
     */
    intents: GatewayIntentBits[] = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
  ) {
    this.client = new Client({ intents });
    this.commandManager = new CommandManager(commands);
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    this.client.once(Events.ClientReady, () => {
      this.logger.info(`setupEventListeners - Bot logged in as ${this.client.user?.tag}`);
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

    const role = interaction.guild.roles.cache.get(config.hideRoleId);
    const member = interaction.member instanceof GuildMember ? interaction.member : null;
    if (!role || !member) {
      await interaction.reply({
        content: "I couldn't hide the channel. Ask an admin to check my Manage Roles permission.",
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
          content: "I couldn't hide the channel. Ask an admin to check my Manage Roles permission.",
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
      if (!guild) continue; // bot is no longer in that server; leave the record alone

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
  }

  public getCommandManager(): CommandManager {
    return this.commandManager;
  }

  public getClient(): Client {
    return this.client;
  }
}
