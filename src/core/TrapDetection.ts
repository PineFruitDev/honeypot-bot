import { MessageType, type Message } from 'discord.js';

/**
 * The one rule that decides whether a message trips the trap.
 *
 * It lives apart from Bot on purpose. The question "does this message mean someone gets
 * removed from the server?" is the highest consequence decision this bot makes, and it has
 * to be answerable in a test without a gateway connection, a guild, or a fake Discord.
 */

/**
 * Everything the trap reads off a message, and nothing more.
 *
 * Narrow deliberately. Spelling the inputs out makes it plain that message content is not
 * among them: the bot requests no Message Content intent and the trap does not care what
 * was typed, only that somebody typed it somewhere they were told not to.
 */
export interface TrapMessageFacts {
  guildId: string | null | undefined;
  channelId: string;
  authorId: string;
  /** Discord's message type. Decides whether this is a post or a notice about a member. */
  type: MessageType | undefined;
  /** Set when a webhook posted this, rather than a user or a bot account. */
  webhookId?: string | null;
}

/** Why the trap took no action. Logged, so a quiet trap can be explained. */
export type TrapIgnoreReason =
  | 'not-in-a-guild'
  | 'posted-by-me'
  | 'not-the-trap-channel'
  | 'discord-member-notice'
  | 'posted-by-a-webhook';

/**
 * What to do about a message.
 *
 * Deleting and catching are separate because one case needs the first without the second:
 * a webhook post should come down, but there is no account behind it to kick.
 */
export type TrapVerdict =
  | { catch: true; deleteMessage: true }
  | { catch: false; deleteMessage: boolean; reason: TrapIgnoreReason };

/**
 * Notices Discord writes about a member, into a channel the member did not choose.
 *
 * Every one of these arrives authored by the member it concerns, so to the old gate they
 * looked exactly like somebody posting in the trap. Acting on one removes a real person for
 * joining, boosting or buying something, which is the worst thing this bot could do. The
 * route in is an admin pointing the server's system or safety-alerts channel at a trap that
 * was converted from an existing channel: `isProtectedChannel` refuses to convert those
 * channels at setup, but it cannot stop the designation moving afterwards.
 *
 * Checked by type rather than through discord.js's `Message#system`, which is simply "not
 * one of Default, Reply, ChatInputCommand, ContextMenuCommand" and so is true for notices
 * that *are* a member's deliberate act in this channel. `ThreadCreated` is the one that
 * matters: creating a thread named "free nitro .ru/x" in the trap needs no permission beyond
 * the server default, and treating every system type as a notice would have handed spammers
 * a free bypass, visible in the channel to everyone and unactioned.
 *
 * Anything not listed falls through to the normal catch path, which is also the behaviour
 * the bot had before this list existed.
 */
const MEMBER_NOTICE_TYPES: ReadonlySet<MessageType> = new Set([
  // Staff pinning or unpinning a message. An action on an existing message, not a post, and
  // it needs Manage Messages, so the only people who can trigger it are moderators.
  MessageType.ChannelPinnedMessage,
  MessageType.UserJoin,
  MessageType.GuildBoost,
  MessageType.GuildBoostTier1,
  MessageType.GuildBoostTier2,
  MessageType.GuildBoostTier3,
  MessageType.GuildInviteReminder,
  MessageType.AutoModerationAction,
  MessageType.RoleSubscriptionPurchase,
  MessageType.PurchaseNotification,
  // The poll itself is an ordinary message and is caught on the way in. Its result notice
  // lands later in the same channel, and catching that too would punish one post twice.
  MessageType.PollResult,
  MessageType.GuildIncidentAlertModeEnabled,
  MessageType.GuildIncidentAlertModeDisabled,
  MessageType.GuildIncidentReportRaid,
  MessageType.GuildIncidentReportFalseAlarm
]);

/** Lift the facts off a live message so the decision itself stays free of discord.js. */
export function trapMessageFacts(message: Message): TrapMessageFacts {
  return {
    guildId: message.guildId,
    channelId: message.channelId,
    authorId: message.author.id,
    type: message.type,
    webhookId: message.webhookId
  };
}

/**
 * Decide what a message means for the trap.
 *
 * Two groups are pointedly not exempt here:
 *
 *   - Bot accounts. Catching self propagating spam bots is the entire purpose of the
 *     channel, so a bot that posts is caught like anyone else. Only this bot's own
 *     messages are skipped, because it posts the trap message itself.
 *   - Admins and moderators. Who is spared is a per guild policy, and it is applied in
 *     EnforcementService, the single place every route into a catch passes through. Making
 *     that call twice, in two files, is how the two copies drift apart.
 *
 * @param selfId this bot's user ID, or undefined before the client is ready
 * @param isTrapChannel the store's lookup, passed in so the decision stays pure
 */
export function evaluateTrapMessage(
  facts: TrapMessageFacts,
  selfId: string | undefined,
  isTrapChannel: (guildId: string, channelId: string) => boolean
): TrapVerdict {
  if (!facts.guildId) return ignore('not-in-a-guild');
  if (selfId !== undefined && facts.authorId === selfId) return ignore('posted-by-me');

  // Exact channel match, which also means a thread hanging off the trap is not the trap.
  // A thread carries its own ID, and someone replying in one has not posted in the channel
  // they were warned about. The notice that *created* the thread is a different matter: it
  // lands in the parent channel and is caught, which is what keeps the thread route closed.
  if (!isTrapChannel(facts.guildId, facts.channelId)) return ignore('not-the-trap-channel');

  // Left wholly alone, the notice included: clearing Discord's own join and boost notices
  // is not the bot's call.
  if (facts.type !== undefined && MEMBER_NOTICE_TYPES.has(facts.type)) {
    return ignore('discord-member-notice');
  }

  // A webhook post is not an account acting in this server, so there is nobody to kick.
  // Three things populate webhookId, and none of them should be removed for it: a plain
  // webhook, whose author ID is synthesised from the webhook and belongs to no member; a
  // crossposted announcement, whose author posted in a different server entirely; and
  // another app's interaction reply, where the member ran the command and the app only
  // answered. Take the payload down and stop there. A webhook spamming a channel is fixed
  // by deleting the webhook, which is an admin's job and not this bot's.
  if (facts.webhookId) {
    return { catch: false, deleteMessage: true, reason: 'posted-by-a-webhook' };
  }

  return { catch: true, deleteMessage: true };
}

function ignore(reason: TrapIgnoreReason): TrapVerdict {
  return { catch: false, deleteMessage: false, reason };
}
