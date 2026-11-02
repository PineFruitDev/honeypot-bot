/** Bounded admission: no waiting queue, one action per guild, four globally.
 * Rejected events do no REST work. Cooldowns and deduplication expire after a minute.
 */
export class AbuseGuard {
  private active = new Set<string>();
  private recent = new Map<string, number>();
  private users = new Map<string, number>();
  private guilds = new Map<string, { until: number; count: number; next: number }>();

  acquire(guild: string, user: string, event: string, now = Date.now()): (() => void) | null {
    for (const [key, expiry] of this.recent) if (expiry <= now) this.recent.delete(key);
    for (const [key, expiry] of this.users) if (expiry <= now) this.users.delete(key);
    for (const [key, state] of this.guilds) if (state.until <= now) this.guilds.delete(key);
    const key = guild + ':' + user;
    const state = this.guilds.get(guild);
    if (this.active.size >= 4 || this.active.has(guild) || this.recent.has(event) ||
        this.users.has(key) || (state && (state.count >= 10 || state.next > now)) ||
        this.recent.size >= 10000) return null;
    this.recent.set(event, now + 60000);
    this.users.set(key, now + 10000);
    this.guilds.set(guild, { until: state?.until ?? now + 60000, count: (state?.count ?? 0) + 1, next: now + 1000 });
    this.active.add(guild);
    return () => { this.active.delete(guild); };
  }
}
