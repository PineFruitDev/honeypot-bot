import { Logger } from './Logger.js';

/**
 * Startup configuration validation.
 *
 * Every value the bot needs is declared once in SPECS below and checked once, on the way
 * up, before a client is constructed or a token is sent anywhere. A bad value is a startup
 * failure rather than an opaque Discord error twenty seconds later, and the failure names
 * every key that is wrong in a single message so one restart is enough to fix all of them.
 *
 * Redaction invariant: a problem message is built from the templates in this file and may
 * interpolate a key name, a list position or a count. It never interpolates a configured
 * value, not for a malformed token and not for a misspelled enum. Anything that needs to
 * show a value belongs in a log line that masks secrets, not in an error. `test/config.test.js`
 * holds this invariant down with hostile values.
 */

export type NodeEnv = 'development' | 'production' | 'test';

export interface BotConfig {
  discordToken: string;
  discordClientId: string;
  nodeEnv: NodeEnv;
  dataDir: string;
  devGuildId?: string;
  developerIds: string[];
  isDevelopment: boolean;
  isProduction: boolean;
}

/** One key, one reason, no value. */
export interface ConfigProblem {
  key: string;
  reason: string;
}

/**
 * Thrown once, listing every problem found. Carries the problems structurally so a caller
 * can report them its own way without re-parsing the message.
 */
export class ConfigValidationError extends Error {
  public readonly problems: readonly ConfigProblem[];

  constructor(problems: readonly ConfigProblem[]) {
    const lines = problems.map(problem => `  - ${problem.key}: ${problem.reason}`);
    super(
      [
        `Configuration is invalid, the bot will not start (${problems.length} problem(s)):`,
        ...lines,
        'Values are never shown in these messages. Compare your .env against .env.example.'
      ].join('\n')
    );
    this.name = 'ConfigValidationError';
    this.problems = problems;
  }

  /** The keys at fault, for a caller that wants the list rather than the prose. */
  public get keys(): string[] {
    return [...new Set(this.problems.map(problem => problem.key))];
  }
}

type ParseResult<T> = { ok: true; value: T; normalized?: string } | { ok: false; reason: string };

interface ConfigKeySpec<T> {
  key: string;
  /** A secret is never echoed back, not even masked, outside of maskSecret(). */
  secret?: boolean;
  /** Absent and no default means a missing-key problem. */
  default?: string;
  /** What a good value looks like. Static text, so it can never carry a value. */
  expected: string;
  parse: (raw: string) => ParseResult<T>;
}

/** Discord IDs are 17-20 digit snowflakes. */
const SNOWFLAKE = /^\d{17,20}$/;

/** The placeholders .env.example ships with, lowercased. A copied-but-unedited .env is common. */
const PLACEHOLDERS = new Set([
  'your_bot_token_here',
  'your_bot_client_id_here',
  'your_user_id_here',
  'changeme',
  'xxx',
  'todo'
]);

const NODE_ENVS: readonly NodeEnv[] = ['development', 'production', 'test'];

function parseToken(raw: string): ParseResult<string> {
  if (/^bot\s/i.test(raw)) {
    return { ok: false, reason: 'has a "Bot " prefix, store the bare token with no prefix' };
  }
  if (/\s/.test(raw)) {
    return { ok: false, reason: 'contains whitespace, which a Discord bot token never does' };
  }

  const segments = raw.split('.');
  if (segments.length !== 3 || segments.some(segment => segment.length === 0)) {
    return {
      ok: false,
      reason: 'is malformed, a Discord bot token is three dot-separated segments'
    };
  }
  if (raw.length < 50) {
    return { ok: false, reason: 'is too short to be a Discord bot token (under 50 characters)' };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(raw)) {
    return { ok: false, reason: 'contains characters a Discord bot token never contains' };
  }

  return { ok: true, value: raw };
}

function parseSnowflake(raw: string): ParseResult<string> {
  if (!SNOWFLAKE.test(raw)) {
    return { ok: false, reason: 'is not a Discord ID (expected 17 to 20 digits)' };
  }
  return { ok: true, value: raw };
}

/**
 * A comma-separated ID list. Problems are reported by position, which is enough to find the
 * offending entry in an editor without the message quoting it.
 */
function parseIdList(raw: string): ParseResult<string[]> {
  const entries = raw
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);

  const badPositions: number[] = [];
  entries.forEach((entry, index) => {
    if (!SNOWFLAKE.test(entry) || PLACEHOLDERS.has(entry.toLowerCase())) {
      badPositions.push(index + 1);
    }
  });

  if (badPositions.length > 0) {
    const positions = badPositions.join(', ');
    const plural = badPositions.length === 1 ? 'entry' : 'entries';
    return {
      ok: false,
      reason: `${plural} at position ${positions} of the comma-separated list ${
        badPositions.length === 1 ? 'is' : 'are'
      } not a Discord ID (expected 17 to 20 digits)`
    };
  }

  return { ok: true, value: [...new Set(entries)], normalized: entries.join(',') };
}

function parseNodeEnv(raw: string): ParseResult<NodeEnv> {
  const lowered = raw.toLowerCase();
  if (!NODE_ENVS.includes(lowered as NodeEnv)) {
    return { ok: false, reason: `is not one of ${NODE_ENVS.join(', ')}` };
  }
  return { ok: true, value: lowered as NodeEnv, normalized: lowered };
}

function parseDataDir(raw: string): ParseResult<string> {
  if (raw.includes('\0')) {
    return { ok: false, reason: 'contains a null byte, which is not valid in a path' };
  }
  if (/[\r\n]/.test(raw)) {
    return { ok: false, reason: 'contains a line break, which is not valid in a path' };
  }
  return { ok: true, value: raw, normalized: raw };
}

/**
 * The whole contract, in declaration order. Adding a value the bot depends on means adding
 * a line here, which is what keeps "validated once, at startup" true as the bot grows.
 */
const SPECS: readonly ConfigKeySpec<unknown>[] = [
  {
    key: 'DISCORD_TOKEN',
    secret: true,
    expected: 'the bot token from the Discord developer portal',
    parse: parseToken
  },
  {
    key: 'DISCORD_CLIENT_ID',
    expected: 'the application ID from the Discord developer portal',
    parse: parseSnowflake
  },
  {
    key: 'NODE_ENV',
    default: 'production',
    expected: `one of ${NODE_ENVS.join(', ')}`,
    parse: parseNodeEnv
  },
  {
    key: 'DATA_DIR',
    default: 'data',
    expected: 'a directory path the bot can write to',
    parse: parseDataDir
  },
  {
    key: 'DEV_GUILD_ID',
    default: '',
    expected: 'a test guild Discord ID, or empty',
    parse: raw => raw ? parseSnowflake(raw) : { ok: true, value: undefined }
  },
  {
    key: 'DEVELOPER_IDS',
    default: '',
    expected: 'a comma-separated list of Discord user IDs, or empty',
    parse: parseIdList
  }
];

/** The keys this module checks, in declaration order. */
export const CONFIG_KEYS: readonly string[] = SPECS.map(spec => spec.key);

export class Environment {
  private static logger = new Logger({ context: 'Environment' });

  /** Set on the first successful validate(). Its presence is what makes validation once-only. */
  private static resolved: BotConfig | null = null;

  /**
   * Validate the whole environment and return the resolved config.
   *
   * Idempotent: the first call does the work, later calls hand back the same frozen object.
   * Startup code should not have to care which of the two entry points ran first, and a
   * value cannot drift between the check and the use.
   */
  public static validate(): BotConfig {
    if (this.resolved) return this.resolved;

    this.logger.info('validate - Validating configuration...');

    const problems: ConfigProblem[] = [];
    const values = new Map<string, unknown>();

    for (const spec of SPECS) {
      const raw = process.env[spec.key];
      const trimmed = typeof raw === 'string' ? raw.trim() : undefined;

      // Whitespace-only counts as absent. A key present but blank is the usual shape of a
      // half-filled .env, and treating it as set would push the failure into Discord's lap.
      if (trimmed === undefined || trimmed.length === 0) {
        if (spec.default === undefined) {
          problems.push({ key: spec.key, reason: `is required but not set (${spec.expected})` });
          continue;
        }

        const parsed = spec.parse(spec.default);
        if (!parsed.ok) {
          // A default that its own parser rejects is a bug in SPECS above, not in anyone's
          // .env. Say so rather than resolve the key to undefined and boot anyway.
          problems.push({
            key: spec.key,
            reason: 'has a built-in default that fails its own check, this is a bug in Environment.ts'
          });
          continue;
        }

        values.set(spec.key, parsed.value);
        this.applyNormalized(spec, parsed.normalized ?? spec.default);
        continue;
      }

      if (PLACEHOLDERS.has(trimmed.toLowerCase())) {
        problems.push({
          key: spec.key,
          reason: `is still the placeholder from .env.example (${spec.expected})`
        });
        continue;
      }

      // A quoted value is almost always a copy-paste artefact: dotenv keeps the quotes when
      // they are mismatched, and the resulting token fails authentication for no visible reason.
      if (this.isQuoted(trimmed)) {
        problems.push({
          key: spec.key,
          reason: `is wrapped in quotes, remove them (${spec.expected})`
        });
        continue;
      }

      const parsed = spec.parse(trimmed);
      if (!parsed.ok) {
        problems.push({ key: spec.key, reason: `${parsed.reason} (${spec.expected})` });
        continue;
      }

      values.set(spec.key, parsed.value);
      this.applyNormalized(spec, parsed.normalized ?? trimmed);
    }

    if (problems.length > 0) {
      const error = new ConfigValidationError(problems);
      this.logger.error(`validate - ${error.message}`);
      throw error;
    }

    const nodeEnv = values.get('NODE_ENV') as NodeEnv;
    const config: BotConfig = {
      discordToken: values.get('DISCORD_TOKEN') as string,
      discordClientId: values.get('DISCORD_CLIENT_ID') as string,
      nodeEnv,
      dataDir: values.get('DATA_DIR') as string,
      devGuildId: values.get('DEV_GUILD_ID') as string | undefined,
      developerIds: values.get('DEVELOPER_IDS') as string[],
      isDevelopment: nodeEnv === 'development',
      isProduction: nodeEnv === 'production'
    };

    this.resolved = Object.freeze({
      ...config,
      developerIds: Object.freeze([...config.developerIds]) as string[]
    });

    this.logger.info('validate - Configuration valid');
    this.logResolved(this.resolved);

    return this.resolved;
  }

  /**
   * The validated config. Validates on first use so a caller reached outside the startup
   * path still gets checked values rather than whatever happens to be in process.env.
   */
  public static getConfig(): BotConfig {
    return this.resolved ?? this.validate();
  }

  /** Drop the cached result so the next validate() runs again. For tests. */
  public static reset(): void {
    this.resolved = null;
  }

  /**
   * Write the normalized value back to process.env for the keys that other modules read
   * directly (Logger checks NODE_ENV). Secrets are left exactly as they were found.
   */
  private static applyNormalized(spec: { key: string; secret?: boolean }, value: string): void {
    if (spec.secret) return;
    process.env[spec.key] = value;
  }

  private static isQuoted(value: string): boolean {
    return (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    );
  }

  /**
   * Report what was configured without reproducing any of it.
   *
   * A secret is reported as present and nothing more, not even masked: a masked token still
   * publishes the ends of a live credential into every log aggregator and pasted screenshot
   * the logs reach, and "present and the right shape" is the only fact startup needs. The
   * client ID is public by design (it is in the bot's own invite URL), so it stays.
   */
  private static logResolved(config: BotConfig): void {
    this.logger.info(`validate - Environment: ${config.nodeEnv}`);
    this.logger.info(`validate - Discord client ID: ${config.discordClientId}`);
    this.logger.info('validate - Discord credential is configured');
    this.logger.info(`validate - Data directory: ${config.dataDir}`);
    if (process.env.REGISTER_ON_BOOT) this.logger.warn('validate - REGISTER_ON_BOOT is ignored; register commands explicitly with npm run register.');
    this.logger.info(`validate - Developer IDs configured: ${config.developerIds.length}`);
  }
}
