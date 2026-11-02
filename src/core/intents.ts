import { GatewayIntentBits } from 'discord.js';

/**
 * The gateway intents this bot runs on, and the guard that keeps the list that short.
 *
 * Intents are the one piece of least privilege that cannot be fixed after the fact by an
 * admin editing a role: whatever the code asks for on connect is what the application has
 * to justify in the Developer Portal, and a privileged intent turns a bot anyone can add
 * into one that needs verification above 100 servers. So the list is a named constant with
 * a test around it rather than an argument nobody reads.
 */

/** Guilds and GuildMessages. Both unprivileged, and together they are the whole trap. */
export const REQUIRED_INTENTS: readonly GatewayIntentBits[] = [
  // Guild, channel and role state. Without it there is no cache to match a trap against.
  GatewayIntentBits.Guilds,
  // Message *events* in guilds. The trap only needs to know that somebody posted.
  GatewayIntentBits.GuildMessages
] as const;

/**
 * The three intents Discord gates behind a portal toggle and, past 100 servers, review.
 *
 * None of them are needed here. Message Content is not: the trap fires on the existence of
 * a message, never its text. Guild Members is not: the member object arrives inside the
 * message and interaction payloads, which is everywhere this bot reads roles. Presence is
 * not: the bot never looks at who is online.
 */
export const PRIVILEGED_INTENTS: readonly GatewayIntentBits[] = [
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildPresences,
  GatewayIntentBits.MessageContent
] as const;

const INTENT_NAMES = new Map<GatewayIntentBits, string>([
  [GatewayIntentBits.Guilds, 'Guilds'],
  [GatewayIntentBits.GuildMessages, 'GuildMessages'],
  [GatewayIntentBits.GuildMembers, 'GuildMembers (privileged)'],
  [GatewayIntentBits.GuildPresences, 'GuildPresences (privileged)'],
  [GatewayIntentBits.MessageContent, 'MessageContent (privileged)']
]);

/** Readable name for an intent bit, for log lines and error messages. */
export function intentName(intent: GatewayIntentBits): string {
  return INTENT_NAMES.get(intent) ?? `Unknown intent (${intent})`;
}

/**
 * Which of the given intents are privileged? Empty for the set this bot ships with.
 *
 * Tested bitwise rather than with `includes`, because discord.js accepts a pre-combined
 * bitfield as happily as a list of single bits, and a mask carrying Message Content would
 * walk straight past a membership check.
 */
export function privilegedIntentsIn(intents: readonly GatewayIntentBits[]): GatewayIntentBits[] {
  const combined = intents.reduce((mask, intent) => mask | BigInt(intent), 0n);
  return PRIVILEGED_INTENTS.filter(privileged => (combined & BigInt(privileged)) !== 0n);
}

/**
 * Refuse to build a client that would request a privileged intent.
 *
 * Throwing at construction means the mistake surfaces as a failed boot with a named intent
 * in the log, rather than as a gateway disconnect that reads like a bad token.
 */
export function assertLeastPrivilegeIntents(intents: readonly GatewayIntentBits[]): void {
  const privileged = privilegedIntentsIn(intents);
  if (privileged.length) {
    throw new Error(
      `Refusing to connect with privileged intents: ${privileged
        .map(intentName)
        .join(', ')}. This bot is designed to run without them; see src/core/intents.ts.`
    );
  }
}

/** The intent set as readable names, for the one line logged at startup. */
export function describeIntents(intents: readonly GatewayIntentBits[]): string {
  return intents.length ? intents.map(intentName).join(', ') : 'none';
}
