import { createHash, randomUUID } from 'node:crypto';

/**
 * The one logger. Everything the bot prints goes through here, which is what makes the two
 * guarantees below enforceable rather than aspirational:
 *
 *  - Secrets never reach stdout. The bot token, `Authorization` headers and webhook tokens
 *    are scrubbed from every message, every structured field and every serialized argument,
 *    including the ones buried in an error's stack.
 *  - User message content never reaches stdout. The trap only needs to know that someone
 *    posted, never what they wrote, so content is reduced to a length and a hash.
 *
 * Nothing else in `src/` is allowed to call `console` directly. `test/logger.test.js` fails
 * the build if something does.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};

export const LOG_LEVELS = Object.keys(LEVEL_ORDER) as LogLevel[];

/** Correlation fields. Ids and flags only, never free text. */
export type LogContext = Record<string, string | number | boolean | null | undefined>;

export interface LogEntry {
  timestamp: string;
  level: Exclude<LogLevel, 'silent'>;
  component?: string;
  message: string;
  fields: LogContext;
  args: string[];
}

/** Where a formatted line ends up. Swappable so tests can read what was written. */
export type LogSink = (level: Exclude<LogLevel, 'silent'>, line: string) => void;

export interface LoggerOptions {
  /** Component name, e.g. `Bot`. Shown as the tag on every line. */
  context?: string;
  /** Overrides the level resolved from the environment. */
  level?: LogLevel;
  /** Correlation fields carried by every line this logger writes. */
  fields?: LogContext;
  sink?: LogSink;
}

export const REDACTED = '[redacted]';

/**
 * Field names whose value is user-authored text rather than an id. These are replaced with
 * a digest wherever they appear, at any depth, in a field set or a serialized argument.
 */
const CONTENT_KEYS = new Set([
  'content',
  'cleanContent',
  'messageContent',
  'text',
  'body',
  'nickname',
  'displayName',
  'username'
]);

/**
 * Hash salt, fresh per process. Two identical messages hash the same while the bot is up,
 * which is enough to spot a flood repeating one payload. It deliberately does not survive a
 * restart, so a digest can never be walked back to the text that produced it.
 */
const HASH_SALT = randomUUID();

const SECRET_PATTERNS: Array<{ pattern: RegExp; replace: string | ((...m: string[]) => string) }> = [
  // A bot token or a JWT: three base64url runs joined by dots. Length floors keep this off
  // version strings and file names.
  {
    pattern: /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
    replace: REDACTED
  },
  // `Authorization: Bot <token>`, which is how the token reaches the REST calls, and the
  // shape most likely to show up in a thrown request error.
  { pattern: /\b(Bot|Bearer)\s+[A-Za-z0-9._-]{8,}/gi, replace: (_m, scheme) => `${scheme} ${REDACTED}` },
  // Webhook URLs: the id is harmless and worth keeping, the trailing token is not.
  {
    pattern: /(discord(?:app)?\.com\/api\/webhooks\/\d+\/)[A-Za-z0-9._-]+/gi,
    replace: (_m, prefix) => `${prefix}${REDACTED}`
  },
  // `DISCORD_TOKEN=...`, `"secret": "..."`, and anything else named like a credential.
  {
    pattern:
      /\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|apikey|authorization|credential)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(["']?)([^\s"',;}]+)\3/gi,
    replace: (_m, key, separator, quote) => `${key}${separator}${quote}${REDACTED}${quote}`
  }
];

/**
 * Scrub secrets from a string.
 *
 * The configured token is matched literally first. The patterns that follow are the safety
 * net for everything shaped like a credential, but an exact match on the value the process
 * was given is the one check that cannot be fooled by an unusual token format.
 */
export function redact(input: string, env: NodeJS.ProcessEnv = process.env): string {
  let output = input;

  for (const name of ['DISCORD_TOKEN', 'DISCORD_CLIENT_SECRET']) {
    const value = env[name];
    // Short values are skipped: a placeholder like `x` would otherwise shred every line.
    if (value && value.length >= 16 && output.includes(value)) {
      output = output.split(value).join(REDACTED);
    }
  }

  for (const { pattern, replace } of SECRET_PATTERNS) {
    output = output.replace(pattern, replace as (substring: string, ...args: unknown[]) => string);
  }

  // Two patterns can land on the same credential, e.g. `Authorization: Bot <token>` is hit
  // by both the token shape and the header name. Adjacent markers describe one secret, so
  // print one.
  return output.replace(/\[redacted\](?:\s+\[redacted\])+/g, REDACTED);
}

/**
 * Reduce user-authored text to something safe to keep: how long it was, and a hash that ties
 * repeats of the same payload together. The text itself is never returned.
 */
export function describeContent(value: unknown): string {
  if (value === null || value === undefined) return '<none>';
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '<none>';
  if (text.length === 0) return '<empty>';

  const hash = createHash('sha256').update(HASH_SALT).update(text).digest('hex').slice(0, 10);
  return `<redacted chars=${text.length} hash=${hash}>`;
}

/**
 * Resolve the threshold from the environment.
 *
 * `LOG_LEVEL` wins when it names a real level. Otherwise `NODE_ENV=development` turns debug
 * on, which is the behaviour this bot already had, and everything else lands on info.
 */
export function resolveLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const requested = env.LOG_LEVEL?.trim().toLowerCase();
  if (requested && (LOG_LEVELS as string[]).includes(requested)) {
    return requested as LogLevel;
  }
  return env.NODE_ENV === 'development' ? 'debug' : 'info';
}

/** True when `level` is at or above the configured threshold. */
export function isEnabled(level: Exclude<LogLevel, 'silent'>, threshold: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[threshold];
}

/** Drop undefined and null so an absent id does not print as `guildId=undefined`. */
function compactFields(fields: LogContext): LogContext {
  const out: LogContext = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    out[key] = CONTENT_KEYS.has(key) ? describeContent(value) : value;
  }
  return out;
}

/**
 * Render one logged argument. Errors keep their message and stack, objects are walked so
 * content keys can be swapped for digests, and whatever comes out is scrubbed.
 */
export function formatArg(value: unknown, env: NodeJS.ProcessEnv = process.env): string {
  let rendered: string;

  if (value instanceof Error) {
    rendered = value.stack ? `${value.name}: ${value.message}\n${value.stack}` : `${value.name}: ${value.message}`;
  } else if (typeof value === 'string') {
    rendered = value;
  } else if (typeof value === 'object' && value !== null) {
    const seen = new WeakSet<object>();
    rendered =
      JSON.stringify(value, (key, inner) => {
        if (CONTENT_KEYS.has(key)) return describeContent(inner);
        if (typeof inner === 'object' && inner !== null) {
          if (seen.has(inner)) return '<circular>';
          seen.add(inner);
        }
        if (typeof inner === 'bigint') return inner.toString();
        return inner;
      }) ?? String(value);
  } else {
    rendered = String(value);
  }

  return redact(rendered, env);
}

/** `key=value` pairs, in insertion order, for the text format. */
function renderFields(fields: LogContext): string {
  const pairs = Object.entries(fields).map(([key, value]) => `${key}=${value}`);
  return pairs.length > 0 ? ` {${pairs.join(' ')}}` : '';
}

/**
 * Render an entry. `LOG_FORMAT=json` gives one JSON object per line for a log shipper to
 * parse; the default stays close to what this bot printed before, with the correlation
 * fields appended.
 */
export function formatEntry(entry: LogEntry, env: NodeJS.ProcessEnv = process.env): string {
  if (env.LOG_FORMAT?.trim().toLowerCase() === 'json') {
    return JSON.stringify({
      timestamp: entry.timestamp,
      level: entry.level,
      component: entry.component,
      message: entry.message,
      ...entry.fields,
      ...(entry.args.length > 0 ? { details: entry.args } : {})
    });
  }

  const tag = entry.component ? `[${entry.level.toUpperCase()}] [${entry.component}]` : `[${entry.level.toUpperCase()}]`;
  const details = entry.args.length > 0 ? ` ${entry.args.join(' ')}` : '';
  return `[${entry.timestamp}] ${tag} ${entry.message}${renderFields(entry.fields)}${details}`;
}

const consoleSink: LogSink = (level, line) => {
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else if (level === 'debug') {
    console.debug(line);
  } else {
    console.log(line);
  }
};

export class Logger {
  private context?: string;
  private level?: LogLevel;
  private fields: LogContext;
  private sink: LogSink;

  constructor(options?: LoggerOptions) {
    this.context = options?.context;
    this.level = options?.level;
    this.fields = options?.fields ? compactFields(options.fields) : {};
    this.sink = options?.sink ?? consoleSink;
  }

  /**
   * A logger that carries extra correlation fields. One of these per event is the point:
   * build it at the handler boundary and every line from that event, including the ones
   * written from the catch block, is tagged with the same ids.
   */
  public child(fields: LogContext, options?: { context?: string }): Logger {
    return new Logger({
      context: options?.context ?? this.context,
      level: this.level,
      fields: { ...this.fields, ...compactFields(fields) },
      sink: this.sink
    });
  }

  /** The correlation fields this logger will stamp on its lines. */
  public getFields(): LogContext {
    return { ...this.fields };
  }

  private write(level: Exclude<LogLevel, 'silent'>, message: string, args: unknown[]): void {
    const threshold = this.level ?? resolveLevel();
    if (!isEnabled(level, threshold)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component: this.context,
      message: redact(message),
      fields: this.fields,
      args: args.filter(arg => arg !== undefined).map(arg => formatArg(arg))
    };

    this.sink(level, formatEntry(entry));
  }

  public debug(message: string, ...args: unknown[]): void {
    this.write('debug', message, args);
  }

  public info(message: string, ...args: unknown[]): void {
    this.write('info', message, args);
  }

  public warn(message: string, ...args: unknown[]): void {
    this.write('warn', message, args);
  }

  public error(message: string, ...args: unknown[]): void {
    this.write('error', message, args);
  }

  // Static entry points, for the handful of places that log without holding an instance.
  private static shared = new Logger();

  public static debug(message: string, ...args: unknown[]): void {
    Logger.shared.debug(message, ...args);
  }

  public static info(message: string, ...args: unknown[]): void {
    Logger.shared.info(message, ...args);
  }

  public static warn(message: string, ...args: unknown[]): void {
    Logger.shared.warn(message, ...args);
  }

  public static error(message: string, ...args: unknown[]): void {
    Logger.shared.error(message, ...args);
  }
}

/**
 * Correlation fields for a message event.
 *
 * Typed structurally rather than against discord.js, so the extraction is unit testable with
 * a plain object and the logger keeps no dependency on the library.
 */
export function messageCorrelation(message: {
  id?: string;
  channelId?: string;
  guild?: { id: string } | null;
  guildId?: string | null;
  author?: { id: string } | null;
}): LogContext {
  return {
    event: 'message',
    guildId: message.guild?.id ?? message.guildId ?? undefined,
    channelId: message.channelId,
    messageId: message.id,
    userId: message.author?.id
  };
}

/** Correlation fields for an interaction event: a slash command or a button press. */
export function interactionCorrelation(interaction: {
  id?: string;
  channelId?: string | null;
  guild?: { id: string } | null;
  guildId?: string | null;
  user?: { id: string } | null;
  commandName?: string;
  customId?: string;
}): LogContext {
  return {
    event: interaction.commandName ? 'command' : 'interaction',
    guildId: interaction.guild?.id ?? interaction.guildId ?? undefined,
    channelId: interaction.channelId ?? undefined,
    interactionId: interaction.id,
    userId: interaction.user?.id,
    commandName: interaction.commandName,
    customId: interaction.customId
  };
}
