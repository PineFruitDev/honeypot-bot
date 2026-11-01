import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction
} from 'discord.js';
import { Command, type CommandHelpInfo } from '../core/Command.js';

/**
 * Basic health check that reports gateway and round-trip latency.
 */
export class PingCommand extends Command {
  public readonly data = new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check the bot latency')
    // This bot is only ever added to a server, so nothing is registered for user
    // installs or DM contexts. Narrower install scopes are part of least privilege too.
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

  public readonly helpInfo: CommandHelpInfo = {
    name: 'ping',
    description: 'Check the bot latency',
    usage: '/ping',
    examples: ['/ping'],
    category: 'Utility'
  };

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.reply({ content: 'Pinging...', flags: MessageFlags.Ephemeral });
    const roundTrip = Date.now() - interaction.createdTimestamp;
    const gateway = Math.round(interaction.client.ws.ping);

    await interaction.editReply(
      `**Pong!**\n**Round trip:** ${roundTrip}ms\n**Gateway:** ${gateway}ms`
    );
  }
}
