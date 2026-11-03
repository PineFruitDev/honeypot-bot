import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  type Guild,
  type Interaction,
  type Message,
  type RepliableInteraction
} from 'discord.js';
import { Command } from './Command.js';
import { CommandManager } from './CommandManager.js';
import { AbuseGuard } from '../services/AbuseGuard.js';
import { REQUIRED_INTENTS, assertLeastPrivilegeIntents, describeIntents } from './intents.js';
import { evaluateTrapMessage, trapMessageFacts } from './TrapDetection.js';
import { roleHierarchyIssue, missingGuildPermissions } from '../services/BotPermissions.js';
import { Logger, newCorrelationId, messageCorrelation, interactionCorrelation } from '../services/Logger.js';
import { GuildConfigStore } from '../services/GuildConfigStore.js';
import { EnforcementService } from '../services/EnforcementService.js';
import { HoneypotService } from '../services/HoneypotService.js';
import { PendingActionStore } from '../services/PendingActionStore.js';
import { BUTTON_IDS, statsEmbed } from '../config/honeypotText.js';

/** How long a shutdown waits for catches already in progress before giving up on them. */
const DRAIN_TIMEOUT_MS = 5000;

/**
 * Discord interaction error codes that mean "there is no longer anything to reply to".
 * Retrying or logging these as failures is noise: the interaction expired or was answered.
 */
const DEAD_INTERACTION_CODES = new Set([10062, 40060]);

/**
 * What someone is told when admission control turns their interaction away.
 *
 * Refusing the *work* is correct: AbuseGuard serializes a guild's catches and holds a short
 * per-user cooldown so a spam wave cannot become unbounded REST traffic. Refusing it
 * *silently* is not. An interaction nobody answers is shown to the presser as "This
 * interaction failed" three seconds later, so an admin who runs two `/honeypot` subcommands
 * within the cooldown, or a member who presses Hide Channel while a catch is in flight, is
 * told the bot is broken rather than busy.
 *
 * One ephemeral reply per refused interaction adds no amplification: it is bounded by the
 * inbound interaction rate, which Discord already limits, and it does none of the REST work
 * the refusal exists to prevent.
 */
const BUSY_MESSAGE =
  "I'm already busy with something else in this server. Give it a few seconds and try again.";

/**
 * Main Bot class: owns the Discord client, the command set, and the two events the trap
 * runs on: a message in the trap channel and a press on one of its buttons.
 *
 * Every event handler is a boundary. The bot is in many servers at once, so a guild that
 * has revoked a permission, deleted a channel or hit a rate limit must fail by itself:
 * never as an unhandled rejection, never as a crash, and never silently to the person who
 * pressed the button.
 */
export class Bot {
  private guard = new AbuseGuard();
  private logger = new Logger({ context: 'Bot' });
  private client: Client;
  private commandManager: CommandManager;
  /** Catches in progress, so a shutdown can wait for them instead of abandoning them. */
  private inFlight = new Set<Promise<unknown>>();
  private stopping = false;
  private acceptingEvents = false;

  public markReady(): void { this.acceptingEvents = true; }

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
    intents: readonly GatewayIntentBits[] = REQUIRED_INTENTS
  ) {
    assertLeastPrivilegeIntents(intents);
    this.client = new Client({ intents: [...intents] });
    this.commandManager = new CommandManager(commands);
    this.setupEventListeners();
  }

  /**
   * Hold on to a promise for the duration of a shutdown drain.
   *
   * A catch is a ban plus an unban plus a write to disk. Dropping one halfway through is
   * exactly the state the pending action journal exists to clean up, so it is worth a few
   * seconds at shutdown to not create one.
   */
  private track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work);
    void work.then(() => this.inFlight.delete(work), () => this.inFlight.delete(work));
    return work;
  }

  private setupEventListeners(): void {
    this.client.once(Events.ClientReady, () => {
      this.logger.info('setupEventListeners - Bot logged in', {
        user: this.client.user?.tag,
        guilds: this.client.guilds.cache.size
      });
    });

    this.client.on(Events.MessageCreate, message => {
      void this.track(this.handleMessage(message));
    });

    this.client.on(Events.InteractionCreate, interaction => {
      // The listener itself never returns a rejected promise: an interaction handler that
      // throws is the single easiest way to take a Node process down.
      void this.track(this.routeInteraction(interaction));
    });

    this.client.on(Events.GuildDelete, guild => {
      if (guild.available === false) return;
      void GuildConfigStore.getInstance()?.removeGuild(guild.id).catch(error => {
        this.logger.error('Guild departure cleanup failed; retry on next startup', error);
      });
    });

    this.client.on(Events.Error, error => {
      this.logger.error('setupEventListeners - Discord client error', error);
    });

    this.client.on(Events.ShardError, (error, shardId) => {
      this.logger.error('setupEventListeners - Shard error', error, { shardId });
    });

    this.client.on(Events.ShardDisconnect, (event, shardId) => {
      this.logger.warn('setupEventListeners - Shard disconnected', {
        shardId,
        code: event?.code
      });
    });

    this.client.on(Events.ShardReconnecting, shardId => {
      this.logger.warn('setupEventListeners - Shard reconnecting', { shardId });
    });
  }

  private async routeInteraction(interaction: Interaction): Promise<void> {
    try {
      if (this.stopping || !this.acceptingEvents) {
        if (interaction.isRepliable()) await this.respondEphemeral(interaction, 'The bot is starting or stopping. Please try again shortly.');
        return;
      }
      if (interaction.isButton()) {
        await this.handleButton(interaction);
        return;
      }
      if (interaction.isChatInputCommand()) {
        await this.handleCommand(interaction);
      }
    } catch (error) {
      // Anything that reaches here escaped a handler's own boundary. Log it against the
      // guild it came from and tell the user something, rather than leaving them staring
      // at a spinner.
      const correlationId = newCorrelationId();
      this.logger.error('routeInteraction - Unhandled interaction failure', error, {
        correlationId,
        guildId: interaction.guildId ?? undefined,
        interactionType: interaction.type
      });
      if (interaction.isRepliable()) {
        await this.respondEphemeral(
          interaction,
          `❌ Something went wrong handling that. Staff can look it up with reference \`${correlationId}\`.`
        );
      }
    }
  }

  /**
   * Reply to an interaction ephemerally, whatever state it is already in.
   *
   * Every user-facing error in this bot goes through here. Ephemeral because the trap is a
   * public channel: an error message posted openly tells a room full of people that the
   * trap is misconfigured, which is a hint worth not giving.
   */
  private async respondEphemeral(interaction: RepliableInteraction, content: string): Promise<void> {
    try {
      if (interaction.deferred) {
        await interaction.editReply({ content });
      } else if (interaction.replied) {
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      const code = (error as { code?: number })?.code;
      if (code !== undefined && DEAD_INTERACTION_CODES.has(code)) return;
      this.logger.warn('respondEphemeral - Could not deliver an error message to the user', {
        error: { code }
      });
    }
  }

  /** Anyone who posts in the trap channel is caught. */
  private async handleMessage(message: Message): Promise<void> {
    if (this.stopping || !this.acceptingEvents) return;
    const correlationId = newCorrelationId();
    const log = this.logger.child({ ...messageCorrelation(message), correlationId });
    let release: (() => void) | null = null;
    try {
      const store = GuildConfigStore.getInstance();
      const verdict = evaluateTrapMessage(
        trapMessageFacts(message),
        this.client.user?.id,
        (guildId, channelId) => store?.isTrapChannel(guildId, channelId) ?? false
      );

      if (!verdict.catch) {
        if (verdict.deleteMessage && message.guildId) {
          release = this.guard.acquire(message.guildId, message.author.id, message.id);
          if (release) await message.delete().catch(() => {});
        }
        // Only worth a line for the two that look like a catch and are not, so a staff
        // member asking "why did nothing happen?" finds the answer in the log.
        if (verdict.reason === 'discord-member-notice' || verdict.reason === 'posted-by-a-webhook') {
          log.info(
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
        log.warn(
          `handleMessage - ${message.guildId} is not in the cache, leaving the message alone`
        );
        return;
      }

      if (HoneypotService.isProtectedChannel(guild, message.channelId)) return;
      release = this.guard.acquire(guild.id, message.author.id, message.id);
      if (!release) return;
      const config = GuildConfigStore.getInstance()?.getGuild(guild.id);
      if (!config?.messageId || await EnforcementService.isExempt(guild, message.author,
        message.member, config.exemptUserIds, config.exemptRoleIds)) return;
      await message.delete().catch(() => {});

      await EnforcementService.handleCatch({
        guild,
        user: message.author,
        member: message.member,
        trigger: 'sent a message in the honeypot channel',
        source: 'message',
        correlationId
      });
      await EnforcementService.refreshTrap(guild);
    } catch (error) {
      log.error('handleMessage - Failed to process a trap message:', error);
    } finally { release?.(); }
  }

  private async handleButton(interaction: Interaction): Promise<void> {
    if (!interaction.isButton() || !interaction.guild) return;
    const correlationId = newCorrelationId();
    const log = this.logger.child({ ...interactionCorrelation(interaction), correlationId });
    const store = GuildConfigStore.getInstance();
    const config = store?.getGuild(interaction.guild.id);

    // A trap that has been removed leaves its buttons behind on the old message. Say so
    // instead of leaving the press unanswered until Discord times it out.
    if (!store || !config) {
      const ours: string[] = Object.values(BUTTON_IDS);
      if (ours.includes(interaction.customId)) {
        log.warn('handleButton - Press on a trap that is no longer configured', {
          customId: interaction.customId
        });
        await this.respondEphemeral(
          interaction,
          'That trap is no longer set up in this server, so this button does nothing.'
        );
      }
      return;
    }

    if (interaction.channelId !== config.channelId || interaction.message.id !== config.messageId) {
      await this.respondEphemeral(interaction, 'This trap button has expired. Use the current trap message.');
      return;
    }
    const release = this.guard.acquire(interaction.guild.id, interaction.user.id, interaction.id);
    if (!release) {
      log.warn('handleButton - Admission refused, answering the press rather than letting it expire', {
        customId: interaction.customId
      });
      await this.respondEphemeral(interaction, BUSY_MESSAGE);
      return;
    }
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
                recent: interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ? store.getRecentCatches(guildId) : []
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
            // button path does not escalate a recoverable misclick to a permanent ban.
            requestedAction: 'kick',
            correlationId
          });
          await EnforcementService.refreshTrap(guild);
          return;
        }
      }
    } catch (error) {
      log.error('handleButton - Failed handling a button press', error, {
        customId: interaction.customId
      });
      // The stats and hide paths are a user waiting on an answer. Give them one, with the
      // reference that matches the log line above.
      await this.respondEphemeral(
        interaction,
        `❌ Something went wrong. Staff can look it up with reference \`${correlationId}\`.`
      );
    } finally { release(); }
  }

  /** Give the presser the hide role, so the trap disappears from their channel list. */
  private async handleHide(interaction: Interaction): Promise<void> {
    if (!interaction.isButton() || !interaction.guild) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const config = GuildConfigStore.getInstance()?.getGuild(interaction.guild.id);
    if (!config?.hideRoleId) {
      await this.respondEphemeral(interaction, 'No hide role is configured. Ask an admin to check Manage Roles and run /honeypot setup again.');
      return;
    }

    const guild = interaction.guild;
    const role = guild.roles.cache.get(config.hideRoleId);
    const member = interaction.member instanceof GuildMember ? interaction.member : null;
    if (!role) {
      await interaction.editReply({
        content:
          "I couldn't hide the channel: the **Hide Honeypot** role is gone. Ask an admin to run `/honeypot setup` again."
      });
      return;
    }
    if (!member) {
      await interaction.editReply({
        content: "I couldn't read your server profile, so I can't hide the channel. Try again in a moment."
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
      await interaction.editReply({
        content: `I couldn't hide the channel. ${blocked} Ask an admin to sort that out.`
      });
      return;
    }

    try {
      await member.roles.add(role, 'Honeypot: member chose to hide the trap channel');
      await interaction.editReply({
        content: "Hidden. You won't see that channel again."
      });
    } catch (error) {
      this.logger.error(`handleHide - Could not add the hide role for ${interaction.user.id}:`, error);
      await interaction
        .editReply({
          content:
            "I couldn't hide the channel. Ask an admin to check my **Manage Roles** permission and that my role sits above **Hide Honeypot**."
        })
        .catch(() => {});
    }
  }

  private async handleCommand(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;

    const correlationId = newCorrelationId();
    const log = this.logger.child({
      correlationId,
      guildId: interaction.guildId ?? undefined,
      command: interaction.commandName
    });

    const command = this.commandManager.getCommand(interaction.commandName);
    if (!command) {
      // Usually a command that was registered by an older build and then removed. The user
      // still deserves an answer rather than a silent failure.
      log.warn('handleCommand - Unknown command');
      await this.respondEphemeral(
        interaction,
        '❌ That command is no longer available. It may have been removed in an update.'
      );
      return;
    }

    const release = interaction.guildId ? this.guard.acquire(interaction.guildId, interaction.user.id, interaction.id) : null;
    if (interaction.guildId && !release) {
      log.warn('handleCommand - Admission refused, answering rather than letting the command expire');
      await this.respondEphemeral(interaction, BUSY_MESSAGE);
      return;
    }
    try {
      const validation = await command.validate(interaction);
      if (!validation.valid) {
        log.warn('handleCommand - Validation failed', { reason: validation.reason });
        await this.respondEphemeral(interaction, `❌ ${validation.reason}`);
        return;
      }

      // Commands are not handed process.env: nothing in this bot reads it through the
      // interaction path, and passing it only puts the token in another call frame.
      await command.execute(interaction);
      log.info('handleCommand - Executed command', { userId: interaction.user.id });
    } catch (error) {
      log.error('handleCommand - Error executing command', error);
      await this.respondEphemeral(
        interaction,
        `❌ An error occurred while running that command. Staff can look it up with reference \`${correlationId}\`.`
      );
    } finally { release?.(); }
  }

  /**
   * Re-apply the trap's channel state on boot, and finish anything left half done.
   *
   * A server can change while the bot is offline: someone edits an overwrite, or deletes
   * the trap channel outright. Reconciling at startup means the trap is either correct or
   * cleanly forgotten, never half configured.
   *
   * Each guild is reconciled inside its own boundary. One server that has revoked Manage
   * Channels must not stop the rest from being reconciled, and must not stop the caller
   * from going on to register commands.
   */
  public async reconcileOnBoot(): Promise<{ total: number; failed: number }> {
    const store = GuildConfigStore.getInstance();
    if (!store) return { total: 0, failed: 0 };

    const guilds = store.getAllGuilds();
    let failed = 0;

    for (const { guildId, config } of guilds) {
      try {
        const guild = this.client.guilds.cache.get(guildId);
        if (!guild) { await store.removeGuild(guildId); continue; }
        if (guild.available === false) continue;

        const channel = guild.channels.cache.get(config.channelId);
        if (!channel || channel.type !== ChannelType.GuildText) {
          this.logger.warn('reconcileOnBoot - Trap channel is gone, clearing the config', {
            guildId,
            channelId: config.channelId
          });
          await store.removeGuild(guildId);
          continue;
        }
        await HoneypotService.applyHideFromRoles(guild);
      } catch (error) {
        failed++;
        this.logger.error('reconcileOnBoot - Could not reconcile a guild, continuing', error, {
          guildId
        });
      }
    }

    if (failed > 0) {
      this.logger.warn('reconcileOnBoot - Finished with failures', {
        total: guilds.length,
        failed
      });
    }
    return { total: guilds.length, failed };
  }

  /**
   * Pay off unbans a previous process owed.
   *
   * Runs after reconciliation, per guild, each inside its own boundary. A journal entry for
   * a guild the bot is no longer in is left alone: it cannot be acted on from here, and
   * deleting it would erase the only record that someone is still banned.
   */
  public async recoverPendingActions(): Promise<{ pending: number; guilds: number }> {
    const journal = PendingActionStore.getInstance();
    if (!journal) return { pending: 0, guilds: 0 };

    const pending = journal.list();
    if (journal.degraded) {
      this.logger.error(
        'recoverPendingActions - The pending action journal could not be read, half finished softbans cannot be recovered automatically',
        undefined,
        { action: 'journal_load' }
      );
    }
    if (!pending.length) return { pending: 0, guilds: 0 };

    const guildIds = [...new Set(pending.map(record => record.guildId))];
    let touched = 0;

    for (const guildId of guildIds) {
      const guild: Guild | undefined = this.client.guilds.cache.get(guildId);
      if (!guild) {
        this.logger.warn(
          'recoverPendingActions - Pending softban for a guild the bot is not in, leaving the record',
          { guildId }
        );
        continue;
      }
      try {
        await EnforcementService.recoverPendingSoftbans(guild);
        touched++;
      } catch (error) {
        this.logger.error('recoverPendingActions - Recovery failed for a guild, continuing', error, {
          guildId
        });
      }
    }

    return { pending: pending.length, guilds: touched };
  }

  public async start(): Promise<void> {
    try {
      await this.client.login(this.token);
    } catch (error) {
      this.logger.error('start - Failed to start bot', error);
      throw error;
    }
  }

  /**
   * Shut down without abandoning work.
   *
   * Waits a bounded time for catches already in progress, then flushes both stores so a
   * recorded catch and a journalled softban are on disk before the process goes away. The
   * timeout matters as much as the wait: a hung REST call must not stop the host from
   * restarting the bot.
   */
  public async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.logger.info('stop - Shutting down', { inFlight: this.inFlight.size });

    if (this.inFlight.size) {
      const drained = await Promise.race([
        Promise.allSettled([...this.inFlight]).then(() => true),
        new Promise<boolean>(resolve => {
          const timer = setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS);
          timer.unref?.();
        })
      ]);
      if (!drained) {
        this.logger.warn('stop - Drain timed out, some work was abandoned', {
          inFlight: this.inFlight.size,
          timeoutMs: DRAIN_TIMEOUT_MS
        });
      }
    }

    // Flush after draining: the work above is what produces the writes.
    await Promise.allSettled([
      GuildConfigStore.getInstance()?.flush(),
      PendingActionStore.getInstance()?.flush()
    ]);

    await this.client.destroy();
    this.logger.info('stop - Shutdown complete');
  }

  public getCommandManager(): CommandManager {
    return this.commandManager;
  }

  public getClient(): Client {
    return this.client;
  }
}
