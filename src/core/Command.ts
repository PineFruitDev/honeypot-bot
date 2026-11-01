import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionsString,
  RESTPostAPIChatInputApplicationCommandsJSONBody
} from 'discord.js';
import { Environment } from '../services/Environment.js';
import { humanizePermission } from '../services/BotPermissions.js';

/**
 * Help information for commands
 */
export interface CommandHelpInfo {
  name: string;
  description: string;
  usage: string;
  examples: string[];
  category: string;
}

/**
 * Abstract base class for all Discord commands
 * Each command extends this class and implements its own logic
 */
export abstract class Command {
  /** Command metadata for Discord registration */
  public abstract readonly data: SlashCommandBuilder | any;
  
  /** Help information for the help system */
  public abstract readonly helpInfo: CommandHelpInfo;
  
  /** Optional permissions required for the bot to execute this command */
  public readonly requiredPermissions: PermissionsString[] = [];

  /**
   * Permissions the member running the command must actually hold.
   *
   * `setDefaultMemberPermissions` on the builder is a default Discord shows in the UI, and
   * a server admin can override it per role or per channel. It is a sensible default, not
   * an authorization check, so anything that must only ever run for an operator lists the
   * permission here and gets it verified against the interaction as well.
   */
  public readonly userPermissions: PermissionsString[] = [];

  /** Whether this command can only be used in guilds (not DMs) */
  public readonly guildOnly: boolean = false;
  
  /** Whether this command can only be used by developers */
  public readonly developerOnly: boolean = false;

  /**
   * Execute the command
   * @param interaction The Discord interaction
   * @param env Environment variables (for Cloudflare Workers compatibility)
   */
  public abstract execute(interaction: ChatInputCommandInteraction, env?: any): Promise<void>;

  /**
   * Get the command data for Discord registration
   */
  public getRegistrationData(): RESTPostAPIChatInputApplicationCommandsJSONBody {
    return this.data.toJSON();
  }

  /**
   * Get the command name
   */
  public getName(): string {
    return this.data.name;
  }

  /**
   * Get the command description
   */
  public getDescription(): string {
    return this.helpInfo.description;
  }

  /**
   * Get the help information
   */
  public getHelpInfo(): CommandHelpInfo {
    return this.helpInfo;
  }

  /**
   * Validate if the command can be executed in the current context
   */
  public async validate(interaction: ChatInputCommandInteraction): Promise<{ valid: boolean; reason?: string }> {
    // Check if command is guild-only but used in DM
    if (this.guildOnly && !interaction.inGuild()) {
      return { valid: false, reason: 'This command can only be used in servers.' };
    }
    if (this.guildOnly && !interaction.guild) {
      return {
        valid: false,
        reason: "I can't see this server's details right now. Try again in a moment."
      };
    }

    // Re-check the operator's own permissions, rather than trusting the registered default.
    // Deliberately not gated on being in a guild: a command that declares a permission and
    // then runs somewhere that has no permissions to check is refused, not waved through.
    if (this.userPermissions.length > 0) {
      const held = interaction.memberPermissions;
      if (!held) {
        return {
          valid: false,
          reason: "I couldn't read your permissions here, so I'm not running that."
        };
      }
      const lacking = this.userPermissions.filter(permission => !held.has(permission));
      if (lacking.length > 0) {
        return {
          valid: false,
          reason: `You need the **${lacking
            .map(humanizePermission)
            .join('**, **')}** permission in this server to use that.`
        };
      }
    }

    // Check bot permissions. `members.me` is populated from the guild payload, so this
    // works without the Server Members intent; the member cache generally is not.
    if (this.requiredPermissions.length > 0 && interaction.guild) {
      const botMember = interaction.guild.members.me;
      if (!botMember) {
        return {
          valid: false,
          reason: "I can't read my own permissions in this server right now. Try again in a moment."
        };
      }
      const missing = this.requiredPermissions.filter(
        permission => !botMember.permissions.has(permission)
      );
      if (missing.length > 0) {
        return {
          valid: false,
          reason: `I'm missing the **${missing
            .map(humanizePermission)
            .join('**, **')}** permission in this server. Grant it to my role and try again.`
        };
      }
    }

    // Add developer-only check if needed
    if (this.developerOnly) {
      const config = Environment.getConfig();
      if (!config.developerIds.includes(interaction.user.id)) {
        return { valid: false, reason: 'This command is for developers only.' };
      }
    }

    return { valid: true };
  }
}