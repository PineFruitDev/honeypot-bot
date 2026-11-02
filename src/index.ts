import dotenv from 'dotenv';
import { Events } from 'discord.js';
import { Bot } from './core/Bot.js';
import { Logger } from './services/Logger.js';
import { Environment } from './services/Environment.js';
import { GuildConfigStore } from './services/GuildConfigStore.js';
import { PendingActionStore } from './services/PendingActionStore.js';
import { ALL_COMMANDS } from './commands/index.js';

const logger = new Logger({ context: 'Main Index' });

dotenv.config();

/** Hard ceiling on a graceful shutdown, so a stuck drain cannot block a host restart. */
const SHUTDOWN_TIMEOUT_MS = 10000;

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
    // And the journal of half finished actions, which has to exist before the first catch
    // can be recorded in it.
    await PendingActionStore.init(config.dataDir);

    logger.info('Initializing bot', { commands: ALL_COMMANDS.length });

    const bot = new Bot(config.discordToken, ALL_COMMANDS);

    // Once online: reconcile each trap against what is actually in the server, pay off any
    // unban a previous run owed, then make sure Discord is holding the command set this
    // build ships. Reconciliation runs first because it is local and instant, while
    // registration is a round trip.
    //
    // Every step here is independently guarded. This handler runs detached from main, so
    // an unguarded throw inside it becomes an unhandled rejection, and a failure in one
    // step must never cost the bot the steps after it.
    bot.getClient().once(Events.ClientReady, () => {
      void onReady();
    });

    async function onReady(): Promise<void> {
      try {
        const reconciled = await bot.reconcileOnBoot();
        logger.info('Reconciled traps on boot', reconciled);
      } catch (error) {
        logger.error('Trap reconciliation failed, continuing to start up', error);
      }

      try {
        const recovered = await bot.recoverPendingActions();
        if (recovered.pending) {
          logger.warn('Recovered half finished actions from a previous run', recovered);
        }
      } catch (error) {
        logger.error('Pending action recovery failed, continuing to start up', error);
      }

    }

    /**
     * One shutdown path, used by signals and by a fatal error.
     *
     * Guarded against re-entry: a host that sends SIGTERM and then SIGINT, or an impatient
     * operator pressing Ctrl-C twice, must not start two drains. Bounded, because a drain
     * that never finishes is indistinguishable from a hang.
     */
    let shuttingDown = false;
    async function shutdown(signal: string, exitCode = 0): Promise<void> {
      if (shuttingDown) {
        logger.warn('Shutdown already in progress, ignoring', { signal });
        return;
      }
      shuttingDown = true;
      logger.info('Shutting down gracefully', { signal });

      const timer = setTimeout(() => {
        logger.error('Shutdown timed out, exiting anyway', undefined, {
          signal,
          timeoutMs: SHUTDOWN_TIMEOUT_MS
        });
        process.exit(exitCode || 1);
      }, SHUTDOWN_TIMEOUT_MS);
      timer.unref();

      try {
        await bot.stop();
      } catch (error) {
        logger.error('Shutdown failed', error, { signal });
      }
      clearTimeout(timer);
      process.exit(exitCode);
    }

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    /**
     * A rejection nobody caught is a bug, but it is not a reason to stop moderating a
     * hundred servers. Log it with everything that is known about it and keep running;
     * Node's default for unhandled rejections is to terminate the process.
     */
    process.on('unhandledRejection', reason => {
      logger.error('Unhandled promise rejection, the bot keeps running', reason);
    });

    /**
     * An uncaught exception has left the process in an unknown state, so this one does
     * exit, but through the same drain as a signal: a half written journal entry is worse
     * than a slow restart.
     */
    process.on('uncaughtException', error => {
      logger.error('Uncaught exception, shutting down', error);
      void shutdown('uncaughtException', 1);
    });

    await bot.start();
    logger.info('Bot started successfully');
  } catch (error) {
    logger.error('Failed to start bot', error);
    process.exit(1);
  }
}

main();
