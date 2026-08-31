import dotenv from 'dotenv';
import { Logger } from './services/Logger.js';
import { Environment } from './services/Environment.js';
import { CommandRegistrar } from './services/CommandRegistrar.js';
import { ALL_COMMANDS } from './commands/index.js';

dotenv.config();

const logger = new Logger({ context: 'Register' });

/**
 * Register slash commands globally with Discord, by hand.
 *
 * The bot does this for itself on boot, so this is the escape hatch: it forces
 * the call through even when the stored fingerprint says nothing has changed,
 * which is what you want if commands were edited outside this bot or a previous
 * registration went missing. Unlike the boot path it exits non-zero on failure,
 * because someone is watching this one.
 */
async function registerCommands() {
  try {
    Environment.validate();
    const config = Environment.getConfig();

    logger.info(`registerCommands - Forcing registration of ${ALL_COMMANDS.length} commands`);

    const result = await new CommandRegistrar(ALL_COMMANDS, {
      clientId: config.discordClientId,
      dataDir: config.dataDir,
      token: config.discordToken
    }).register({ force: true });

    if (result.outcome === 'failed') {
      process.exit(1);
    }

    logger.info(`registerCommands - Done, ${result.count} command(s) registered`);

  } catch (error) {
    logger.error('registerCommands - Error registering commands:', error);
    process.exit(1);
  }
}

registerCommands();
