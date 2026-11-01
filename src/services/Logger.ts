import { randomUUID } from 'node:crypto';

/**
 * Structured logging with redaction.
 *
 * Two rules this file exists to hold, both of which matter more once the bot is in servers
 * that are not ours:
 *
 *   - **A log line never carries a credential.** Errors thrown by `fetch` and by discord.js
 *     can hold the request that produced them, Authorization header included, so an error
 *     object is never logged whole. Only an allowlist of fields is serialized, and every
 *     string that reaches the output is swept for token shapes on the way out.
 *   - **A failure is attributable.** Every line can carry a correlation ID, a guild ID and
 *     an action, so one guild's failure can be traced through a log that interleaves many.
 *
 * Output is a human readable prefix followed by a compact JSON object, which greps by eye
 * and parses by machine.
 */

/** Structured context attached to a log line. Values must be primitives or plain data. */
export type LogFields = Record<string, unknown>;

/** Error fields that are safe to log. Everything else about an error is dropped. */
const ERROR_FIELD_ALLOWLIST = [
  'name',
  'message',
  'code',
  'status',
  'method',
  'syscall',
  'errno'
] as const;

/** Longest message or field value that reaches the output. */
const MAX_VALUE_LENGTH = 500;

/** How many stack frames to keep. Enough to name the call path, not a whole dump. */
const STACK_FRAMES = 3;

/**
 * Patterns for things that must never be printed.
 *
 * The first catches a bot token or JWT by shape, which covers a token arriving inside a
 * message the bot never parsed. The second catches an Authorization header value even when
 * the token itself does not match the shape. The third catches `KEY=value` spellings of any
 * credential-ish variable, which is how a leaked env dump reads.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}/g, '[redacted-token]'],
  [/\b(Bot|Bearer)\s+[A-Za-z0-9._-]+/gi, '$1 [redacted-token]'],
  [
    /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_?KEY|AUTHORIZATION)[A-Z0-9_]*)\s*[=:]\s*("?)(?:Bot\s+|Bearer\s+)?[^\s",}]+\2/gi,
    '$1=[redacted]'
  ]
];

/**
 * Remove anything credential shaped from a string.
 *
 * Also removes the live bot token by exact match, because a token that fails the shape
 * patterns (a test fixture, a truncated paste) is still a token.
 */
export function redactSecrets(value: string): string {
  let out = value;

  const liveToken = process.env.DISCORD_TOKEN;
  if (liveToken && liveToken.length >= 8) {
    out = out.split(liveToken).join('[redacted-token]');
  }

  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function truncate(value: string): string {
  return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}...` : value;
}

function clean(value: string): string {
  return truncate(redactSecrets(value));
}

/** A URL reduced to origin and path: a query string can carry a token. */
function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return clean(value.split('?')[0]);
  }
}

/**
 * Reduce an error to an allowlisted, redacted plain object.
 *
 * Deliberately drops `requestBody`, `options`, `headers`, `rawError`, `config` and anything
 * else a library attaches: those are the fields that carry credentials and user content.
 * A non-Error throw is reported as such rather than stringified into something that looks
 * like a message.
 */
export function serializeError(error: unknown): LogFields {
  if (error === undefined || error === null) return {};

  if (typeof error !== 'object') {
    return { name: 'NonError', message: clean(String(error)) };
  }

  const source = error as Record<string, unknown>;
  const out: LogFields = {};

  for (const field of ERROR_FIELD_ALLOWLIST) {
    const value = source[field];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      out[field] = clean(value);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[field] = value;
    }
  }

  const url = safeUrl(source.url);
  if (url) out.url = url;

  if (out.name === undefined) {
    out.name = error instanceof Error ? error.constructor.name : 'UnknownError';
  }
  if (out.message === undefined) out.message = '(no message)';

  if (typeof source.stack === 'string') {
    const frames = source.stack
      .split('\n')
      .slice(1, 1 + STACK_FRAMES)
      .map(line => clean(line.trim()));
    if (frames.length) out.stack = frames;
  }

  // One level of cause, same allowlist. A wrapped fetch failure keeps its real reason here.
  if (source.cause && source.cause !== error) {
    const cause = serializeError(source.cause);
    if (Object.keys(cause).length) out.cause = cause;
  }

  return out;
}

/** A short ID for tying a user-facing error message to the log line that explains it. */
export function newCorrelationId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

/** Recursively redact strings in a structured field value, and drop anything unprintable. */
function cleanFieldValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return clean(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return serializeError(value);
  if (depth >= 3) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map(item => cleanFieldValue(item, depth + 1));
  if (typeof value === 'object') {
    const out: LogFields = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = cleanFieldValue(nested, depth + 1);
    }
    return out;
  }
  return undefined;
}

function isErrorLike(value: unknown): boolean {
  if (value instanceof Error) return true;
  if (typeof value !== 'object' || value === null) return true; // a bare string/number is not fields
  const source = value as Record<string, unknown>;
  return typeof source.stack === 'string' && typeof source.message === 'string';
}

/**
 * Serialize fields for output.
 *
 * Exported so tests can assert on exactly what would be printed, without capturing stdout.
 */
export function formatFields(fields: LogFields): string {
  const cleaned: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    const next = cleanFieldValue(value);
    if (next !== undefined) cleaned[key] = next;
  }
  if (!Object.keys(cleaned).length) return '';
  try {
    return JSON.stringify(cleaned);
  } catch {
    return '{"fields":"[unserializable]"}';
  }
}

export class Logger {
  private context?: string;
  private baseFields: LogFields;

  constructor(options?: { context?: string; fields?: LogFields }) {
    this.context = options?.context;
    this.baseFields = options?.fields ? { ...options.fields } : {};
  }

  private static formatTimestamp(): string {
    return new Date().toISOString();
  }

  /** A logger that carries extra context on every line: a correlation ID, a guild. */
  public child(fields: LogFields): Logger {
    return new Logger({ context: this.context, fields: { ...this.baseFields, ...fields } });
  }

  private line(level: string, message: string, fields: LogFields): string {
    const contextTag = this.context ? `[${this.context}]` : `[${level}]`;
    const payload = formatFields({ ...this.baseFields, ...fields });
    return `[${Logger.formatTimestamp()}] ${contextTag} ${clean(message)}${
      payload ? ` ${payload}` : ''
    }`;
  }

  /**
   * Accepts either structured fields or, for older call sites, a bare error as the second
   * argument. An error there is folded into the `error` field rather than printed whole.
   */
  private static asFields(fieldsOrError: unknown): LogFields {
    if (fieldsOrError === undefined) return {};
    if (isErrorLike(fieldsOrError)) return { error: serializeError(fieldsOrError) };
    return fieldsOrError as LogFields;
  }

  public info(message: string, fieldsOrError?: unknown): void {
    console.log(this.line('INFO', message, Logger.asFields(fieldsOrError)));
  }

  public warn(message: string, fieldsOrError?: unknown): void {
    console.warn(this.line('WARN', message, Logger.asFields(fieldsOrError)));
  }

  public error(message: string, error?: unknown, fields?: LogFields): void {
    const merged: LogFields = { ...(fields ?? {}) };
    if (error !== undefined && error !== null) merged.error = serializeError(error);
    console.error(this.line('ERROR', message, merged));
  }

  public debug(message: string, fieldsOrError?: unknown): void {
    if (process.env.NODE_ENV !== 'development') return;
    console.debug(this.line('DEBUG', message, Logger.asFields(fieldsOrError)));
  }

  // Static helpers, for the few places that log before a context exists.
  private static readonly shared = new Logger();

  public static info(message: string, fieldsOrError?: unknown): void {
    this.shared.info(message, fieldsOrError);
  }

  public static warn(message: string, fieldsOrError?: unknown): void {
    this.shared.warn(message, fieldsOrError);
  }

  public static error(message: string, error?: unknown, fields?: LogFields): void {
    this.shared.error(message, error, fields);
  }

  public static debug(message: string, fieldsOrError?: unknown): void {
    this.shared.debug(message, fieldsOrError);
  }
}
