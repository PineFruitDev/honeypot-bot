// Tests for the trap's trigger rule: which messages mean somebody gets removed from the
// server, and which ones the trap has to leave alone.
//
// This is the highest consequence decision in the bot, in both directions. A trap that
// catches one message too many bans a real member for joining a server; a trap that ignores
// one message too many hands spammers a route straight through it. Most of the cases below
// are about the boundary between those two.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Events, MessageType } from 'discord.js';
import { Bot } from '../dist/core/Bot.js';
import { evaluateTrapMessage, trapMessageFacts } from '../dist/core/TrapDetection.js';

const GUILD = '111111111111111111';
const TRAP = '222222222222222222';
const THREAD = '666666666666666666';
const SELF = '333333333333333333';
const OFFENDER = '444444444444444444';

/** An ordinary message in the trap channel, with the fields each test overrides. */
function facts(overrides = {}) {
  return {
    guildId: GUILD,
    channelId: TRAP,
    authorId: OFFENDER,
    type: MessageType.Default,
    webhookId: null,
    ...overrides
  };
}

/**
 * The store's lookup, recording what it was asked. The guild's trap is TRAP and nothing
 * else, in this guild and no other.
 */
function trapLookup() {
  const asked = [];
  const isTrapChannel = (guildId, channelId) => {
    asked.push({ guildId, channelId });
    return guildId === GUILD && channelId === TRAP;
  };
  return { asked, isTrapChannel };
}

const verdict = (overrides, selfId = SELF) =>
  evaluateTrapMessage(facts(overrides), selfId, trapLookup().isTrapChannel);

test('a message in the trap channel is a catch', () => {
  assert.deepEqual(verdict({}), { catch: true, deleteMessage: true });
});

test('a reply and a slash command in the trap are caught like any other post', () => {
  // Discord gives these their own message types. They are still somebody choosing to post
  // in the channel they were told not to.
  for (const type of [MessageType.Reply, MessageType.ChatInputCommand]) {
    assert.equal(verdict({ type }).catch, true);
  }
});

test('a message anywhere else is left completely alone', () => {
  const elsewhere = verdict({ channelId: '555555555555555555' });

  assert.equal(elsewhere.catch, false);
  assert.equal(elsewhere.reason, 'not-the-trap-channel');
  // The bot has no business deleting messages in a channel it was not pointed at.
  assert.equal(elsewhere.deleteMessage, false);
});

test('a message inside a thread is judged on the thread, not its parent', () => {
  // A message in a thread carries the thread's own channel ID. The lookup has to be asked
  // about that ID: resolving it up to the parent would make every thread under the trap a
  // trap of its own, and someone replying in a thread has not posted in the channel the
  // trap message warned them about.
  const { asked, isTrapChannel } = trapLookup();

  const inThread = evaluateTrapMessage(facts({ channelId: THREAD }), SELF, isTrapChannel);

  assert.deepEqual(asked, [{ guildId: GUILD, channelId: THREAD }]);
  assert.equal(inThread.catch, false);
  assert.equal(inThread.reason, 'not-the-trap-channel');
});

test("the same channel ID in another guild is not that guild's trap", () => {
  // Snowflakes are unique, so this should never happen in practice. It is asserted because
  // the lookup is given both IDs, and dropping the guild half would be an invisible change
  // that only misfires once the bot is in two servers.
  const { asked, isTrapChannel } = trapLookup();

  const otherGuild = evaluateTrapMessage(
    facts({ guildId: '777777777777777777' }),
    SELF,
    isTrapChannel
  );

  assert.deepEqual(asked, [{ guildId: '777777777777777777', channelId: TRAP }]);
  assert.equal(otherGuild.catch, false);
  assert.equal(otherGuild.reason, 'not-the-trap-channel');
});

test('a direct message is never a catch', () => {
  for (const guildId of [null, undefined, '']) {
    const dm = evaluateTrapMessage(facts({ guildId }), SELF, trapLookup().isTrapChannel);
    assert.equal(dm.catch, false);
    assert.equal(dm.reason, 'not-in-a-guild');
  }
});

test('the bot never catches its own trap message', () => {
  // The sticky trap message is posted by the bot into the trap channel, and re-posted after
  // every catch. Missing this would make the first catch trigger an endless loop.
  const own = verdict({ authorId: SELF });

  assert.equal(own.catch, false);
  assert.equal(own.reason, 'posted-by-me');
  assert.equal(own.deleteMessage, false);
});

test('another bot posting in the trap is caught', () => {
  // Not an oversight to be tidied up later: catching spam bots is what the channel is for.
  // Bot accounts can be banned like any other, so they get no special treatment.
  assert.equal(verdict({ authorId: '888888888888888888' }).catch, true);
});

test('a join notice is ignored and left in place', () => {
  // The author of a "member joined" notice is the member who joined. Acting on one would
  // ban a real person for joining the server. Reachable whenever an admin points the
  // server's system channel at a trap that was converted from an existing channel.
  const joined = verdict({ type: MessageType.UserJoin });

  assert.equal(joined.catch, false);
  assert.equal(joined.reason, 'discord-member-notice');
  // Not deleted either: clearing Discord's own join and boost notices is not the bot's call.
  assert.equal(joined.deleteMessage, false);
});

test('notices about a member doing something elsewhere are all ignored', () => {
  // Each of these is authored by the member it concerns, and each lands in a channel the
  // server designated rather than one the member picked.
  const notices = [
    MessageType.GuildBoost,
    MessageType.GuildBoostTier1,
    MessageType.GuildBoostTier2,
    MessageType.GuildBoostTier3,
    MessageType.RoleSubscriptionPurchase,
    MessageType.PurchaseNotification,
    MessageType.GuildInviteReminder,
    MessageType.AutoModerationAction,
    MessageType.GuildIncidentReportRaid
  ];

  for (const type of notices) {
    const notice = verdict({ type });
    assert.equal(notice.catch, false, `type ${type} should not be a catch`);
    assert.equal(notice.reason, 'discord-member-notice');
  }
});

test('a pin notice is ignored, because pinning is not posting', () => {
  // Only someone with Manage Messages can trigger this, so the member it names is a
  // moderator, and what they did was act on a message that was already there.
  const pinned = verdict({ type: MessageType.ChannelPinnedMessage });

  assert.equal(pinned.catch, false);
  assert.equal(pinned.reason, 'discord-member-notice');
});

test('creating a thread in the trap is still a catch', () => {
  // The hole this closes: discord.js reports every message type outside Default, Reply and
  // the two command types as "system", and a thread-created notice is one of them. Exempting
  // the lot would let a spammer create a thread called "free nitro .ru/x" in the trap, with
  // no permission beyond the server default, and walk away unactioned with the name sitting
  // in a channel every member can read. The notice lands in the parent channel, authored by
  // the member who chose to put it there, so it is a catch.
  const created = verdict({ type: MessageType.ThreadCreated });

  assert.equal(created.catch, true);
  assert.equal(created.deleteMessage, true);
});

test('an unrecognised message type falls through to a catch', () => {
  // Discord adds types over time. An unknown one has to behave like a post rather than
  // silently becoming a hole, which is also what the bot did before the notice list existed.
  assert.equal(verdict({ type: 999 }).catch, true);
  assert.equal(verdict({ type: undefined }).catch, true);
});

test('a webhook post is deleted but nobody is punished for it', () => {
  // A webhook has no account behind it. The ID on the message is synthesised from the
  // webhook, so banning it would fail and then file a report naming a member who does
  // not exist.
  const hook = verdict({ authorId: 'webhook-1', webhookId: 'webhook-1' });

  assert.equal(hook.catch, false);
  assert.equal(hook.reason, 'posted-by-a-webhook');
  assert.equal(hook.deleteMessage, true);
});

test("another app's interaction reply in the trap is not a catch", () => {
  // An interaction reply is delivered as a webhook message, and its author is the app's real
  // bot account. It is spared anyway: the member ran the command, and the app only answered
  // where it was asked to. Removing the app would punish it for the member's choice.
  const reply = verdict({ authorId: 'app-1', webhookId: 'app-1' });

  assert.equal(reply.catch, false);
  assert.equal(reply.reason, 'posted-by-a-webhook');
  assert.equal(reply.deleteMessage, true);
});

test('a crossposted announcement is not a catch either', () => {
  // webhookId is set but the author is a member of a different server, who posted in that
  // server's announcement channel. They never touched this one.
  const crossposted = verdict({ authorId: OFFENDER, webhookId: 'follower-webhook-1' });

  assert.equal(crossposted.catch, false);
  assert.equal(crossposted.reason, 'posted-by-a-webhook');
});

test('a member notice from a webhook is still read as a notice', () => {
  // Order matters only in that neither path may fall through to a catch.
  const notice = verdict({ type: MessageType.UserJoin, webhookId: 'hook-1' });

  assert.equal(notice.catch, false);
});

test('the self check is skipped rather than guessed at before the client is ready', () => {
  // client.user is null until READY. MessageCreate does not fire before then, but if it
  // ever did, an undefined self ID must not accidentally match a real author.
  assert.equal(
    evaluateTrapMessage(facts({}), undefined, trapLookup().isTrapChannel).catch,
    true
  );
});

test('facts are read off a message without touching its content', () => {
  const read = trapMessageFacts({
    guildId: GUILD,
    channelId: TRAP,
    author: { id: OFFENDER, bot: false },
    type: MessageType.Default,
    webhookId: null,
    content: 'http://definitely-not-a-scam.example',
    get cleanContent() {
      throw new Error('the trap must not read message content');
    }
  });

  assert.deepEqual(read, {
    guildId: GUILD,
    channelId: TRAP,
    authorId: OFFENDER,
    type: MessageType.Default,
    webhookId: null
  });
});

test('an edit or a deletion is never a second catch', async () => {
  // The trap deletes every message it catches, so a MessageDelete listener would turn one
  // offence into two. An edit is not a new offence either. Asserted on the live client
  // because the protection here is the absence of a listener, which is easy to add back by
  // accident while adding an unrelated event.
  const bot = new Bot('not-a-real-token');
  const client = bot.getClient();

  try {
    assert.equal(client.listenerCount(Events.MessageCreate), 1);
    assert.equal(client.listenerCount(Events.MessageUpdate), 0);
    assert.equal(client.listenerCount(Events.MessageDelete), 0);
    assert.equal(client.listenerCount(Events.MessageBulkDelete), 0);
  } finally {
    await bot.stop();
  }
});
