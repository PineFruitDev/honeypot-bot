import dotenv from 'dotenv';
import { Events } from 'discord.js';
import { Bot } from './core/Bot.js';
import { Logger } from './services/Logger.js';
import { Environment } from './services/Environment.js';
import { GuildConfigStore } from './services/GuildConfigStore.js';
import { ALL_COMMANDS } from './commands/index.js';

const logger = new Logger({ context: 'Main Index' });

dotenv.config();

/**
 * Main entry point for the Discord bot
 */
async function main() {
  try {
    Environment.validate();
    const config = Environment.getConfig();

    // Load persisted trap config before the client comes online, so a message arriving in
    // the first moments after login is matched against a trap the bot already knows about.
    await GuildConfigStore.init(config.dataDir);

    logger.info(`Initializing bot with ${ALL_COMMANDS.length} commands`);

    const bot = new Bot(config.discordToken, ALL_COMMANDS);

    // Once online, reconcile each trap against what is actually in the server.
    //
    // Commands are deliberately not registered here. Registration is a bulk overwrite
    // against every installation at once, so it belongs to an operator running
    // `npm run register` against a reviewed payload, not to whichever build the host
    // happened to restart. Starting up does not change what Discord has registered.
    bot.getClient().once(Events.ClientReady, async () => {
      await bot.reconcileOnBoot();
    });

    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      await bot.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down gracefully...');
      await bot.stop();
      process.exit(0);
    });

    await bot.start();
    logger.info('Bot started successfully!');
  } catch (error) {
    logger.error('Failed to start bot:', error);
    process.exit(1);
  }
}

main();
