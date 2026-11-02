import dotenv from 'dotenv';
import { Logger } from './services/Logger.js';
import { Environment } from './services/Environment.js';
import {
  CommandRegistrar,
  RegistrationPlan,
  RegistrationTarget,
  describeTarget,
  resolveRegistrationTarget
} from './services/CommandRegistrar.js';
import { ALL_COMMANDS } from './commands/index.js';

dotenv.config();

const logger = new Logger({ context: 'Register' });

const USAGE = `
Usage: npm run register -- [target] [action]

Target (defaults to global when NODE_ENV=production, otherwise DEV_GUILD_ID):
  --global              Every installation of this application
  --guild [id]          One guild; defaults to DEV_GUILD_ID

Action (defaults to registering the command set this build ships):
  --dry-run             Print what would change, call nothing
  --force               Re-send even when the stored fingerprint matches
  --clear               Remove every command from the target
  --rollback            Re-send the payload the target held before the current one
  --help                Print this

Register to the dev guild first, review the diff, then register global.
`.trim();

interface Options {
  target?: RegistrationTarget;
  action: 'register' | 'dry-run' | 'clear' | 'rollback';
  force: boolean;
}

/** Nothing here is worth a dependency; the flag set is six long. */
function parseArgs(argv: string[]): Options | { usage: true; error?: string } {
  const options: Options = { action: 'register', force: false };
  const actions = argv.filter(arg => ['--dry-run', '--clear', '--rollback'].includes(arg));
  if (actions.length > 1) return { usage: true, error: 'Pick one action; --dry-run cannot be combined with --clear or --rollback' };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case '--help':
      case '-h':
        return { usage: true };
      case '--global':
        if (options.target) return { usage: true, error: 'Pick one target' };
        options.target = { scope: 'global' };
        break;
      case '--guild': {
        if (options.target) return { usage: true, error: 'Pick one target' };
        // The ID is optional: bare --guild means "the dev guild from the environment".
        const next = argv[i + 1];
        const guildId = next && !next.startsWith('-') ? (i++, next) : process.env.DEV_GUILD_ID;
        if (!guildId) {
          return { usage: true, error: '--guild needs an ID, or DEV_GUILD_ID set in the environment' };
        }
        if (!/^\d{17,20}$/.test(guildId)) return { usage: true, error: '--guild requires a valid Discord guild ID' };
        options.target = { scope: 'guild', guildId };
        break;
      }
      case '--dry-run':
        options.action = 'dry-run';
        break;
      case '--clear':
        options.action = 'clear';
        break;
      case '--rollback':
        options.action = 'rollback';
        break;
      case '--force':
        options.force = true;
        break;
      default:
        return { usage: true, error: `Unknown argument: ${arg}` };
    }
  }

  return options;
}

function logPlan(plan: RegistrationPlan): void {
  const where = describeTarget(plan.target);

  if (!plan.changed) {
    logger.info(`plan - ${where} already holds these ${plan.count} command(s), nothing to send`);
    return;
  }

  logger.info(`plan - ${plan.count} command(s) would be written to ${where}`);
  logger.info(`plan - Fingerprint ${plan.previousHash?.slice(0, 12) ?? 'none'} -> ${plan.hash.slice(0, 12)}`);

  if (plan.baselineUnknown) {
    logger.warn(
      'plan - No payload is retained for this target, so the command set that is live there is unknown. ' +
      'This bulk overwrite replaces whatever it currently holds.'
    );
    for (const command of ALL_COMMANDS) {
      logger.info(`plan -   send /${command.getName()}`);
    }
    return;
  }

  for (const name of plan.added) logger.info(`plan -   + /${name}`);
  for (const name of plan.modified) logger.info(`plan -   ~ /${name}`);
  for (const name of plan.removed) {
    logger.warn(`plan -   - /${name} would stop existing on ${where}`);
  }

  if (!plan.added.length && !plan.modified.length && !plan.removed.length) {
    logger.info('plan - No command changed; the payload differs only in fields outside the command list');
  }
}

/**
 * Register slash commands with Discord, by hand.
 *
 * This is the only thing that registers: the bot does not do it on boot,
 * because a bulk overwrite from a restarting process would push whatever that
 * build happened to ship to every installation. The intended sequence is
 * `--guild` to the dev server, `--dry-run --global` to read the diff, then
 * `--global` once it looks right.
 *
 * Idempotent by default: an unchanged command set is skipped rather than
 * re-sent. `--force` is for when Discord and the stored fingerprint disagree,
 * which is what happens if commands were edited from the portal or registered
 * from another machine. Exits non-zero on failure, because someone is watching
 * this one.
 */
async function registerCommands() {
  const parsed = parseArgs(process.argv.slice(2));

  if ('usage' in parsed) {
    if (parsed.error) logger.error(`registerCommands - ${parsed.error}`);
    logger.info(USAGE);
    process.exit(parsed.error ? 2 : 0);
  }

  try {
    Environment.validate();
    const config = Environment.getConfig();

    const target = parsed.target ?? resolveRegistrationTarget({
      nodeEnv: config.nodeEnv,
      devGuildId: config.devGuildId
    });

    const registrar = new CommandRegistrar(ALL_COMMANDS, {
      clientId: config.discordClientId,
      dataDir: config.dataDir,
      token: config.discordToken,
      target
    });

    if (parsed.action === 'dry-run') {
      logPlan(await registrar.plan());
      logger.info('registerCommands - Dry run, nothing was sent to Discord');
      return;
    }

    if (parsed.action === 'clear') {
      const result = await registrar.clear();
      if (result.outcome === 'failed') process.exit(1);
      logger.info(`registerCommands - Cleared ${describeTarget(target)}`);
      return;
    }

    if (parsed.action === 'rollback') {
      const result = await registrar.rollback();
      if (!result) process.exit(1);
      if (result.outcome === 'failed') process.exit(1);
      logger.info(`registerCommands - Rolled ${describeTarget(target)} back to ${result.count} command(s)`);
      return;
    }

    if (target.scope === 'global') {
      // Global is every server at once, so say what is about to change first.
      logPlan(await registrar.plan());
    }

    const result = await registrar.register({ force: parsed.force });

    if (result.outcome === 'failed') {
      process.exit(1);
    }

    logger.info(
      result.outcome === 'unchanged'
        ? `registerCommands - ${describeTarget(target)} was already up to date, nothing sent`
        : `registerCommands - Done, ${result.count} command(s) registered on ${describeTarget(target)}`
    );

  } catch (error) {
    logger.error('registerCommands - Error registering commands:', error);
    process.exit(1);
  }
}

registerCommands();
