// Tests for `/honeypot config` applying all of a run or none of it.
//
// The subcommand takes several options at once, and a refused one ends the run with a single
// reply. So anything already written before the refusal is a change the admin was never told
// about, on the setting that decides what happens to the next person who trips the trap.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PermissionFlagsBits } from 'discord.js';

import { GuildConfigStore } from '../dist/services/GuildConfigStore.js';
import { HoneypotCommand } from '../dist/commands/HoneypotCommand.js';

const GUILD = '111111111111111111';
const TRAP_CHANNEL = 'trap-1';
const LOG_CHANNEL = 'log-1';

let dataDir;

/** The slice of a guild the config subcommand reads. The bot holds every server permission. */
function createGuild() {
  return {
    id: GUILD,
    roles: { everyone: { id: 'everyone-role' } },
    members: { me: { id: 'bot', permissions: { has: () => true } } },
    // Left empty on purpose: applyHideFromRoles finds no trap channel and returns, so these
    // tests assert what the command stores and says rather than re-testing the service.
    channels: { cache: new Map() }
  };
}

/**
 * A log channel the bot can or cannot post in.
 *
 * A channel overwrite taking Send Messages back off the bot is the realistic shape of this:
 * the role has it server wide, so only the per-channel check sees the gap.
 */
function createLogChannel({ canSend = true } = {}) {
  return {
    id: LOG_CHANNEL,
    permissionsFor: () => ({
      has: flag => (flag === PermissionFlagsBits.SendMessages ? canSend : true)
    })
  };
}

/** A fake interaction that records every reply the command sends. */
function createInteraction({ action = null, logChannel = null } = {}) {
  const replies = [];
  return {
    replies,
    deferReply: async () => {},
    editReply: async payload => {
      replies.push(typeof payload === 'string' ? payload : payload.content);
    },
    options: {
      getString: name => (name === 'action' ? action : null),
      getChannel: name => (name === 'log-channel' ? logChannel : null),
      getUser: () => null,
      getRole: () => null
    }
  };
}

const run = interaction => new HoneypotCommand().config(interaction, createGuild());

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'honeypot-config-atomic-'));
  GuildConfigStore.instance = null;
  const store = await GuildConfigStore.init(dataDir);
  await store.setTrap(GUILD, {
    channelId: TRAP_CHANNEL,
    hideRoleId: 'hide-role',
    createdByBot: false,
    messageId: 'warning-1',
    action: 'kick'
  });
});

afterEach(async () => {
  GuildConfigStore.instance = null;
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('a log channel the bot cannot post in does not quietly change the action', async () => {
  // The whole point of the bug: the admin is answered about the log channel, and the trap is
  // left on Ban. The next person to post in it is banned rather than kicked, and the only
  // message they got back talked about a permission on a different channel.
  const interaction = createInteraction({
    action: 'ban',
    logChannel: createLogChannel({ canSend: false })
  });

  await run(interaction);

  assert.equal(interaction.replies.length, 1);
  assert.match(interaction.replies[0], /Send Messages/);
  assert.match(interaction.replies[0], new RegExp(LOG_CHANNEL));

  const config = GuildConfigStore.getInstance().getGuild(GUILD);
  assert.equal(config.action, 'kick', 'the refused run must not have changed the action');
  assert.equal(config.logChannelId, undefined, 'and must not have set the log channel either');
});

test('the trap itself as a log channel does not quietly change the action', async () => {
  const interaction = createInteraction({
    action: 'ban',
    logChannel: { id: TRAP_CHANNEL, permissionsFor: () => ({ has: () => true }) }
  });

  await run(interaction);

  assert.match(interaction.replies[0], /cannot be the trap itself/);
  assert.equal(GuildConfigStore.getInstance().getGuild(GUILD).action, 'kick');
});

test('a run with every option valid applies and reports all of it', async () => {
  const interaction = createInteraction({
    action: 'ban',
    logChannel: createLogChannel()
  });

  await run(interaction);

  assert.equal(interaction.replies.length, 1);
  assert.match(interaction.replies[0], /Action is now \*\*Ban\*\*/);
  assert.match(interaction.replies[0], /Action reports now go to/);

  const config = GuildConfigStore.getInstance().getGuild(GUILD);
  assert.equal(config.action, 'ban');
  assert.equal(config.logChannelId, LOG_CHANNEL);
});

test('an action the bot lacks the permission for is refused before anything is written', async () => {
  // Server-wide Ban Members is missing, so the action is refused. The log channel is fine,
  // and must not be applied on the way out of a run that reported a failure.
  const guild = createGuild();
  guild.members.me.permissions.has = flag => flag !== PermissionFlagsBits.BanMembers;

  const interaction = createInteraction({ action: 'ban', logChannel: createLogChannel() });
  await new HoneypotCommand().config(interaction, guild);

  assert.match(interaction.replies[0], /Ban Members/);

  const config = GuildConfigStore.getInstance().getGuild(GUILD);
  assert.equal(config.action, 'kick');
  assert.equal(config.logChannelId, undefined, 'the valid option is not applied by a refused run');
});

test('a run with no options at all says so and changes nothing', async () => {
  const interaction = createInteraction();

  await run(interaction);

  assert.match(interaction.replies[0], /Nothing to change/);
  assert.equal(GuildConfigStore.getInstance().getGuild(GUILD).action, 'kick');
});
