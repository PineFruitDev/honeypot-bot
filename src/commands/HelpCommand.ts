import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction
} from 'discord.js';
import { Command, type CommandHelpInfo } from '../core/Command.js';
import { ALL_COMMANDS } from './index.js';
import { ACCENT } from '../config/honeypotText.js';

/**
 * Auto-generated help built from the command registry, grouped by category.
 */
export class HelpCommand extends Command {
  public readonly data = new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show the available commands and what they do');

  public readonly helpInfo: CommandHelpInfo = {
    name: 'help',
    description: 'Show the available commands and what they do',
    usage: '/help',
    examples: ['/help'],
    category: 'Utility'
  };

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const categories = new Map<string, Command[]>();
    for (const command of ALL_COMMANDS) {
      const category = command.getHelpInfo().category;
      if (!categories.has(category)) categories.set(category, []);
      categories.get(category)!.push(command);
    }

    const embed = new EmbedBuilder()
      .setTitle('Honeypot Bot')
      .setDescription(
        'A trap channel that catches bots and scammers automatically, and leaves real members alone.'
      )
      .setColor(ACCENT);

    for (const [category, commands] of categories) {
      embed.addFields({
        name: category,
        value: commands.map(cmd => `**/${cmd.getName()}**: ${cmd.getDescription()}`).join('\n')
      });
    }

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}
