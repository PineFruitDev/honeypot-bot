import { Logger } from './Logger.js';

/**
 * Direct Discord REST helpers for the member actions the trap applies.
 *
 * discord.js covers almost everything this bot does, but ban and unban go through raw
 * fetch on purpose. The softban needs to see the exact status, Discord error code and
 * retry_after behind a failure so it can wait out a rate limit and tell staff what
 * actually went wrong. discord.js hides all of that behind its own retry queue, which
 * would also mean two competing backoffs stacked on top of each other.
 *
 * Everything else in the bot uses discord.js normally.
 */

const API = 'https://discord.com/api/v10';

/** Coarse outcome of a member action, used for logging and the action report. */
export type ActionResult = 'success' | 'missing_perms' | 'not_banned' | 'error';

/**
 * Why an unban did not succeed, kept verbatim for the logs.
 *
 * A coarse result collapses 400, 429 and 5xx into a single "error", which makes a
 * failing unban impossible to diagnose from logs: you learn that it failed and nothing
 * about why. Callers that need to act on the outcome use ActionResult; callers that
 * need to report it use this.
 */
export interface UnbanDetail {
  result: ActionResult;
  status: number;
  /** Discord's JSON error code (e.g. 50013 Missing Permissions), when the body carries one. */
  code?: number;
  /** Discord's message field, truncated to enough to name the failure in a log line. */
  message?: string;
  /** Seconds Discord asked us to wait, present on a 429. */
  retryAfter?: number;
  /** Set when fetch itself rejected (network level) rather than returning a status. */
  threw?: string;
}

export class DiscordApi {
  private static logger = new Logger({ context: 'DiscordApi' });

  private static token(): string {
    const token = process.env.DISCORD_TOKEN?.trim();
    if (!token) throw new Error('DISCORD_TOKEN is not set');
    return token;
  }

  /** Auth only. A bodyless DELETE has nothing to describe, so it declares no content type. */
  private static authHeaders(): Record<string, string> {
    return { Authorization: `Bot ${this.token()}` };
  }

  private static jsonHeaders(): Record<string, string> {
    return { Authorization: `Bot ${this.token()}`, 'Content-Type': 'application/json' };
  }

  /**
   * X-Audit-Log-Reason is sent as a ByteString, so a reason carrying an em dash or any
   * other non-latin1 character throws when the header is built. Map those to '-' and cap
   * the length rather than losing the action to an encoding error.
   */
  private static auditReason(reason: string): string {
    return reason.replace(/[^ -ÿ]/g, '-').slice(0, 400);
  }

  /**
   * Ban a member, optionally purging their recent messages server wide.
   *
   * @param deleteMessageSeconds how much recent history Discord should delete, clamped to
   *   its 0-604800 (7 day) range. The trap passes the maximum so a spammer's links are
   *   wiped from every channel in the same call that removes them.
   */
  public static async banMember(
    guildId: string,
    userId: string,
    reason: string,
    deleteMessageSeconds = 0
  ): Promise<ActionResult> {
    try {
      const res = await fetch(`${API}/guilds/${guildId}/bans/${userId}`, {
        method: 'PUT',
        signal: AbortSignal.timeout(10000),
        headers: { ...this.jsonHeaders(), 'X-Audit-Log-Reason': this.auditReason(reason) },
        body: JSON.stringify({
          delete_message_seconds: Math.max(0, Math.min(deleteMessageSeconds, 604800))
        })
      });
      if (res.ok) return 'success';
      if (res.status === 403) return 'missing_perms';
      this.logger.warn(`banMember - ${guildId}/${userId} failed with HTTP ${res.status}`);
      return 'error';
    } catch (error) {
      this.logger.error(`banMember - ${guildId}/${userId} threw:`, error);
      return 'error';
    }
  }

  /** A single unban attempt that preserves the full failure detail. */
  public static async unbanMemberDetailed(guildId: string, userId: string): Promise<UnbanDetail> {
    let res: Response;
    try {
      res = await fetch(`${API}/guilds/${guildId}/bans/${userId}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(10000),
        headers: this.authHeaders()
      });
    } catch (error) {
      // A network level reject has no status. Report it as such rather than letting it
      // propagate, because the caller still has a report to post and a record to write.
      return {
        result: 'error',
        status: 0,
        threw: error instanceof Error ? error.message : String(error)
      };
    }

    if (res.ok) return { result: 'success', status: res.status };

    // Read the error body once, best effort: Discord returns {code, message, retry_after}.
    let code: number | undefined;
    let message: string | undefined;
    let retryAfter: number | undefined;
    try {
      const body = (await res.json()) as { code?: number; message?: string; retry_after?: number };
      if (typeof body?.code === 'number') code = body.code;
      if (typeof body?.message === 'string') message = body.message.slice(0, 200);
      if (typeof body?.retry_after === 'number' && Number.isFinite(body.retry_after) && body.retry_after > 0) retryAfter = body.retry_after;
    } catch {
      // Empty or non-JSON body. The status alone still beats a bare "error".
    }
    if (retryAfter === undefined) {
      // A bare 429 from an edge proxy carries only the header.
      const header = Number(res.headers.get('retry-after'));
      if (Number.isFinite(header) && header > 0) retryAfter = header;
    }

    const result: ActionResult =
      res.status === 404 ? 'not_banned' : res.status === 403 ? 'missing_perms' : 'error';
    return { result, status: res.status, code, message, retryAfter };
  }

  /** Format an UnbanDetail for a log line: status, Discord code and retry_after, never bare. */
  public static describeUnban(detail: UnbanDetail): string {
    if (detail.threw) return `${detail.result} (fetch threw: ${detail.threw})`;
    const parts = [`${detail.result} http=${detail.status}`];
    if (detail.code !== undefined) parts.push(`code=${detail.code}`);
    if (detail.retryAfter !== undefined) parts.push(`retry_after=${detail.retryAfter}`);
    if (detail.message) parts.push(`message=${JSON.stringify(detail.message)}`);
    return parts.join(' ');
  }

  /**
   * Is this user currently banned in this guild?
   *
   * Used to ground the softban's "still banned" warning rather than inferring it from a
   * failed unban. Returns null when the check itself fails, so an unknown never becomes
   * a claim in either direction.
   */
  public static async isMemberBanned(guildId: string, userId: string): Promise<boolean | null> {
    try {
      const res = await fetch(`${API}/guilds/${guildId}/bans/${userId}`, {
        signal: AbortSignal.timeout(10000),
        headers: this.authHeaders()
      });
      if (res.status === 404) return false; // no ban record, so not banned
      if (res.ok) return true;
      return null; // 403/429/5xx, genuinely unknown
    } catch {
      return null;
    }
  }

  /** Ban reason proves recovery belongs to this journal entry, not a later staff ban. */
  public static async banReason(guildId: string, userId: string): Promise<string | null> {
    try {
      const res = await fetch(`${API}/guilds/${guildId}/bans/${userId}`, {
        signal: AbortSignal.timeout(10000), headers: this.authHeaders()
      });
      if (!res.ok) return null;
      const body = await res.json() as { reason?: unknown };
      return typeof body.reason === 'string' ? body.reason : null;
    } catch { return null; }
  }

  /**
   * What the ban looks like after a softban attempt finished.
   *
   * Kept separate from `unbanFailed` because "still banned" and "could not tell" are
   * different things to put in front of staff: one is a fact to act on, the other is a
   * check to perform. Collapsing them into a single failure flag means the report either
   * overclaims or underclaims, and both erode trust in it.
   */
  public static banStateFromRecheck(stillBanned: boolean | null): SoftbanBanState {
    if (stillBanned === false) return 'lifted';
    return stillBanned === true ? 'still_banned' : 'unknown';
  }

  /**
   * The second half of a softban: lift the ban just placed, so the net effect is a kick
   * that also purged the offender's recent messages.
   *
   * This is the part that is easy to get wrong. Two rules it exists to hold:
   *
   *   - Never retry an unban immediately. Discord answers a rate limited unban with a
   *     retry_after, and a retry sent inside that same window is guaranteed to fail too,
   *     which turns one transient rate limit into a permanent looking failure.
   *   - Never claim the member is still banned without checking. A failed looking unban
   *     can still have landed, and sending staff to Server Settings > Bans for a ban that
   *     is not there wastes their time and erodes trust in the report.
   *
   * Returns the flag the action report needs plus a log ready description of what happened.
   */
  public static async softbanUnban(
    guildId: string,
    userId: string
  ): Promise<SoftbanUnbanOutcome> {
    let waited = 0;
    let detail = 'no attempt made';

    for (let attempt = 1; attempt <= UNBAN_ATTEMPTS; attempt++) {
      const result = await this.unbanMemberDetailed(guildId, userId);
      detail = `attempt ${attempt}/${UNBAN_ATTEMPTS}: ${this.describeUnban(result)}`;
      // "not_banned" is the 404 case: there is no ban record to delete, which is the
      // state a softban is trying to reach anyway.
      if (result.result === 'success' || result.result === 'not_banned') {
        return { unbanFailed: false, banState: 'lifted', detail };
      }

      if (attempt === UNBAN_ATTEMPTS || result.result === 'missing_perms') break;
      // Wait out Discord's own retry_after when it gave one, otherwise back off gently.
      // Bounded overall so a member is never left banned while the bot sleeps on a
      // rate limit that is not clearing.
      const asked =
        result.retryAfter !== undefined ? Math.ceil(result.retryAfter * 1000) : 250 * attempt;
      if (asked > UNBAN_TOTAL_WAIT_BUDGET_MS - waited) {
        return { unbanFailed: true, banState: 'unknown', retryAt: Date.now() + asked, detail: detail + '; retry delay exceeds immediate budget; recovery required' };
      }
      const waitMs = asked;
      if (waitMs <= 0) break; // budget spent
      waited += waitMs;
      await sleep(waitMs);
    }

    // Every attempt reported failure. Confirm the ban is really still there before saying so.
    const stillBanned = await this.isMemberBanned(guildId, userId);
    const banState = this.banStateFromRecheck(stillBanned);
    if (banState === 'lifted') {
      return {
        unbanFailed: false,
        banState,
        detail: `${detail}, but the ban is gone on re-check, so the softban completed`
      };
    }
    return {
      unbanFailed: true,
      banState,
      detail: `${detail} (ban re-check: ${
        banState === 'still_banned' ? 'member is still banned' : 'inconclusive, assuming still banned'
      })`
    };
  }
}

/** Whether the softban's ban is known to be gone, known to remain, or unverifiable. */
export type SoftbanBanState = 'lifted' | 'still_banned' | 'unknown';

export interface SoftbanUnbanOutcome {
  /** True when the member should be assumed still banned, including the unknown case. */
  unbanFailed: boolean;
  banState: SoftbanBanState;
  /** Log ready description of every attempt and the re-check. */
  detail: string;
  retryAt?: number;
}

/**
 * Softban unban budget: three attempts inside roughly five seconds of waiting.
 *
 * The ceiling matters because a member sits banned until the unban lands. Waiting longer
 * would ride out a bigger rate limit, but it also widens the window where a configured
 * kick looks like a ban to everyone watching. Five seconds covers the retry_after values
 * Discord hands out in practice without leaving the member in limbo.
 */
const UNBAN_ATTEMPTS = 3;
const UNBAN_TOTAL_WAIT_BUDGET_MS = 5000;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
