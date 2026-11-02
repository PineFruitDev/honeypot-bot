// Tests for least privilege: the gateway intents the bot connects with, and the runtime
// permission and hierarchy checks that run before it touches anything.
//
// The cases that matter here are the two failures a guild-level permission check cannot
// see. A channel overwrite can take back what the role grants, so Send Messages server
// wide says nothing about the trap channel. And the role hierarchy sits above every
// permission, so Ban Members does not help against someone whose top role outranks the
// bot's. Discord reports both as the same 50013, after the fact, which is how a trap that
// was never going to work gets reported to staff as "failed".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GatewayIntentBits, PermissionFlagsBits as P } from 'discord.js';
import {
  REQUIRED_INTENTS,
  PRIVILEGED_INTENTS,
  assertLeastPrivilegeIntents,
  privilegedIntentsIn,
  describeIntents
} from '../dist/core/intents.js';
import {
  SETUP_PERMISSIONS,
  TRAP_CHANNEL_PERMISSIONS,
  CONVERSION_CHANNEL_PERMISSIONS,
  LOG_CHANNEL_PERMISSIONS,
  permissionsForAction,
  missingGuildPermissions,
  missingChannelPermissions,
  roleHierarchyIssue,
  memberHierarchyIssue,
  actionBlockedReason,
  auditSetup,
  escalationWarning,
  humanizePermission
} from '../dist/services/BotPermissions.js';
// The shipped registry rather than the classes: /help builds itself from this list, so
// importing it is also how the install-scope assertions below cover what is registered.
import { ALL_COMMANDS } from '../dist/commands/index.js';

const honeypotCommand = () => ALL_COMMANDS.find(command => command.getName() === 'honeypot');

const BOT_ROLE = 10;

/** A stand-in for the slice of a guild the permission checks read. */
function createGuild({ permissions = [], botRolePosition = BOT_ROLE, ownerId = 'owner-1' } = {}) {
  const held = new Set(permissions);
  return {
    id: '111111111111111111',
    ownerId,
    members: {
      me: {
        id: 'bot-1',
        permissions: { has: flag => held.has(flag) },
        roles: { highest: { position: botRolePosition } }
      }
    }
  };
}

/** A channel whose effective permissions for the bot are whatever is passed in. */
function createChannel(effective, id = 'channel-1') {
  const allowed = new Set(effective);
  return { id, permissionsFor: () => ({ has: flag => allowed.has(flag) }) };
}

function createMember({ id = 'offender-1', rolePosition = 1 } = {}) {
  return { id, roles: { highest: { position: rolePosition } } };
}

// --- Gateway intents -------------------------------------------------------------------

test('the shipped intent set is exactly Guilds and GuildMessages', () => {
  assert.deepEqual([...REQUIRED_INTENTS], [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]);
});

test('nothing privileged is in the shipped intent set', () => {
  assert.deepEqual(privilegedIntentsIn(REQUIRED_INTENTS), []);
  assert.doesNotThrow(() => assertLeastPrivilegeIntents(REQUIRED_INTENTS));
});

test('every privileged intent is refused, by name, before the client connects', () => {
  for (const privileged of PRIVILEGED_INTENTS) {
    assert.throws(
      () => assertLeastPrivilegeIntents([...REQUIRED_INTENTS, privileged]),
      /privileged intents/i,
      `intent ${privileged} was allowed through`
    );
  }
});

test('a privileged intent hidden inside a combined bitmask is still caught', () => {
  // discord.js takes a pre-combined bitfield as happily as a list of single bits, so the
  // check is bitwise. A membership test would wave this straight through.
  const mask =
    GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent;

  assert.deepEqual(privilegedIntentsIn([mask]), [GatewayIntentBits.MessageContent]);
  assert.throws(() => assertLeastPrivilegeIntents([mask]), /MessageContent/);
});

test('the startup line names the intents rather than printing a bitfield', () => {
  assert.equal(describeIntents(REQUIRED_INTENTS), 'Guilds, GuildMessages');
});

// --- What each action needs ------------------------------------------------------------

test('Kick Members is on no list, because the kick is carried out as a softban', () => {
  const everything = [
    ...SETUP_PERMISSIONS,
    ...TRAP_CHANNEL_PERMISSIONS,
    ...CONVERSION_CHANNEL_PERMISSIONS,
    ...LOG_CHANNEL_PERMISSIONS,
    ...permissionsForAction('kick'),
    ...permissionsForAction('ban'),
    ...permissionsForAction('timeout'),
    ...permissionsForAction('quarantine')
  ];
  assert.ok(!everything.some(([flag]) => flag === P.KickMembers));
  assert.ok(!everything.some(([flag]) => flag === P.Administrator));
});

test('an action requires only what that action itself does', () => {
  // Escalation is resolved into the action before any of this is consulted, so an action
  // that is still `timeout` belongs to an account over seven days old and involves no ban.
  // Requiring Ban Members here would stop a timeout-only server acting on anyone at all.
  assert.deepEqual(permissionsForAction('timeout').map(([flag]) => flag), [P.ModerateMembers]);
  assert.deepEqual(permissionsForAction('quarantine').map(([flag]) => flag), [P.ManageRoles]);
  assert.deepEqual(permissionsForAction('ban').map(([flag]) => flag), [P.BanMembers]);
  // The kick is a softban, so it is the ban permission it needs, not Kick Members.
  assert.deepEqual(permissionsForAction('kick').map(([flag]) => flag), [P.BanMembers]);
});

test('a timeout-only server with no Ban Members still acts on the catches it can', () => {
  // The regression guard. This configuration is the whole point of a timeout trap, and a
  // gate that demanded Ban Members would turn it into a catch counter that does nothing.
  const guild = createGuild({ permissions: [P.ModerateMembers] });
  assert.equal(actionBlockedReason(guild, 'timeout', createMember()), null);

  // Same for a quarantine server holding only the permission quarantine actually uses.
  const quarantineOnly = createGuild({ permissions: [P.ManageRoles] });
  assert.equal(actionBlockedReason(quarantineOnly, 'quarantine', createMember()), null);

  // The escalated ban is the one thing it cannot do, and that is still refused by name
  // rather than attempted. `handleCatch` resolves a young account to 'ban' before gating.
  assert.match(actionBlockedReason(guild, 'ban', createMember()), /Ban Members/);
});

test('a timeout server is told at setup that escalation will not fire, without being blocked', () => {
  const guild = createGuild({ permissions: [P.ManageChannels, P.ManageRoles, P.ModerateMembers] });
  const withoutBan = createGuild({
    permissions: [P.ManageChannels, P.ManageRoles, P.ModerateMembers, P.BanMembers]
  });

  assert.match(escalationWarning(guild, 'timeout'), /cannot escalate/);
  assert.equal(escalationWarning(withoutBan, 'timeout'), null, 'nothing to warn about');
  assert.equal(escalationWarning(guild, 'ban'), null, 'a ban trap escalates to what it already does');
});

test('the trap channel list covers deleting the spam and reading the history', () => {
  const flags = TRAP_CHANNEL_PERMISSIONS.map(([flag]) => flag);
  assert.ok(flags.includes(P.ManageMessages), 'deleting another member\'s message needs it');
  assert.ok(flags.includes(P.ReadMessageHistory), 'the conversion safety check needs it');
  assert.ok(flags.includes(P.EmbedLinks), 'the sticky trap message is an embed');
});

// --- Guild-level checks ----------------------------------------------------------------

test('a missing server permission is reported with the label Discord uses', () => {
  const guild = createGuild({ permissions: [P.ManageChannels] });
  assert.deepEqual(missingGuildPermissions(guild, SETUP_PERMISSIONS), ['Manage Roles']);
});

test('nothing is claimed missing when the bot cannot see its own member object', () => {
  // Unknown is not the same as absent. Every caller refuses on a gap, so guessing here
  // would block a working trap on a cold cache.
  const guild = { id: 'g', ownerId: 'o', members: { me: null } };
  assert.deepEqual(missingGuildPermissions(guild, SETUP_PERMISSIONS), []);
});

// --- Channel-level checks --------------------------------------------------------------

test('a channel overwrite that takes back a granted permission is caught', () => {
  // The regression guard for this lane. The bot's role carries all five permissions, and
  // the channel denies two of them, which a guild-level check would wave through.
  const guild = createGuild({
    permissions: [
      P.ViewChannel,
      P.SendMessages,
      P.EmbedLinks,
      P.ReadMessageHistory,
      P.ManageMessages
    ]
  });
  const channel = createChannel([P.ViewChannel, P.SendMessages, P.EmbedLinks]);

  assert.deepEqual(missingGuildPermissions(guild, TRAP_CHANNEL_PERMISSIONS), []);
  assert.deepEqual(missingChannelPermissions(guild, channel, TRAP_CHANNEL_PERMISSIONS), [
    'Read Message History',
    'Manage Messages'
  ]);
});

test('a log channel the bot cannot post an embed in is reported', () => {
  const guild = createGuild({ permissions: [P.ViewChannel, P.SendMessages, P.EmbedLinks] });
  const channel = createChannel([P.ViewChannel, P.SendMessages]);
  assert.deepEqual(missingChannelPermissions(guild, channel, LOG_CHANNEL_PERMISSIONS), [
    'Embed Links'
  ]);
});

// --- Role hierarchy --------------------------------------------------------------------

test('a role above the bot cannot be assigned, whatever Manage Roles says', () => {
  const guild = createGuild({ permissions: [P.ManageRoles] });
  const issue = roleHierarchyIssue(guild, {
    id: 'r1',
    name: 'Quarantined',
    position: BOT_ROLE + 1,
    managed: false
  });
  assert.match(issue, /above my own highest role/);
  assert.match(issue, /Quarantined/);
});

test('a role level with the bot cannot be assigned either', () => {
  const guild = createGuild({ permissions: [P.ManageRoles] });
  const issue = roleHierarchyIssue(guild, {
    id: 'r1',
    name: 'Hide Honeypot',
    position: BOT_ROLE,
    managed: false
  });
  assert.match(issue, /above my own highest role/);
});

test('an integration-managed role is refused with its own reason', () => {
  const guild = createGuild({ permissions: [P.ManageRoles] });
  const issue = roleHierarchyIssue(guild, {
    id: 'r1',
    name: 'Nitro Booster',
    position: 1,
    managed: true
  });
  assert.match(issue, /managed by another integration/);
});

test('a plain role below the bot is fine', () => {
  const guild = createGuild({ permissions: [P.ManageRoles] });
  assert.equal(
    roleHierarchyIssue(guild, { id: 'r1', name: 'Hide Honeypot', position: 1, managed: false }),
    null
  );
});

// --- Member hierarchy ------------------------------------------------------------------

test('a member whose top role outranks the bot is refused before the attempt', () => {
  const guild = createGuild({ permissions: [P.BanMembers] });
  const issue = memberHierarchyIssue(guild, createMember({ rolePosition: BOT_ROLE + 5 }));
  assert.match(issue, /at or above mine/);
});

test('the server owner can never be acted on', () => {
  const guild = createGuild({ permissions: [P.BanMembers], ownerId: 'owner-1' });
  const issue = memberHierarchyIssue(guild, createMember({ id: 'owner-1' }));
  assert.match(issue, /own this server/);
});

test('an unknown member is not refused on a guess', () => {
  const guild = createGuild({ permissions: [P.BanMembers] });
  assert.equal(memberHierarchyIssue(guild, null), null);
});

// --- The per-catch gate ----------------------------------------------------------------

test('a catch is blocked with the missing permission named', () => {
  const guild = createGuild({ permissions: [] });
  const reason = actionBlockedReason(guild, 'ban', createMember());
  assert.match(reason, /Ban Members/);
});

test('a catch is blocked on hierarchy even when the permission is held', () => {
  const guild = createGuild({ permissions: [P.BanMembers] });
  const reason = actionBlockedReason(guild, 'ban', createMember({ rolePosition: BOT_ROLE + 1 }));
  assert.match(reason, /at or above mine/);
});

test('a catch the bot can carry out is not blocked', () => {
  const guild = createGuild({ permissions: [P.BanMembers] });
  assert.equal(actionBlockedReason(guild, 'ban', createMember({ rolePosition: 1 })), null);
});

test('a timeout with no Timeout Members is refused, naming that permission', () => {
  const guild = createGuild({ permissions: [P.BanMembers] });
  const reason = actionBlockedReason(guild, 'timeout', createMember());
  assert.match(reason, /Timeout Members/);
  assert.ok(!reason.includes('Ban Members'), 'the ban permission is not what a timeout needs');
});

// --- Setup audit -----------------------------------------------------------------------

const FULLY_PERMITTED = [
  P.ManageChannels,
  P.ManageRoles,
  P.BanMembers,
  P.ViewChannel,
  P.SendMessages,
  P.EmbedLinks,
  P.ReadMessageHistory,
  P.ManageMessages
];

test('setup reports the server and channel gaps together, not one per attempt', () => {
  const guild = createGuild({ permissions: [P.ManageChannels, ...FULLY_PERMITTED.slice(3)] });
  const channel = createChannel([P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ManageChannels]);
  const gaps = auditSetup({ guild, action: 'ban', channel });

  assert.equal(gaps.length, 2);
  assert.match(gaps[0], /Manage Roles/);
  assert.match(gaps[0], /Ban Members/);
  assert.match(gaps[1], /Read Message History/);
  assert.match(gaps[1], /Manage Messages/);
});

test('a gap is reported once, as a server gap, not twice', () => {
  // Manage Messages is missing from the role entirely. That is not a channel override, so
  // listing it under both headings would read as two separate problems to go and fix.
  const guild = createGuild({
    permissions: FULLY_PERMITTED.filter(flag => flag !== P.ManageMessages)
  });
  const channel = createChannel([P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory, P.ManageChannels]);
  const gaps = auditSetup({ guild, action: 'ban', channel });

  assert.equal(gaps.length, 1);
  assert.match(gaps[0], /Manage Messages/);
  assert.match(gaps[0], /in this server/);
});

test('creating a new channel still checks what the bot needs inside it', () => {
  // The bot writes no overwrite for itself on a channel it creates, so whatever it needs
  // in there it has to hold server wide. Without this check setup reports success and
  // leaves an empty channel with no trap message in it.
  const guild = createGuild({
    permissions: FULLY_PERMITTED.filter(flag => flag !== P.SendMessages)
  });
  const gaps = auditSetup({ guild, action: 'kick' });

  assert.equal(gaps.length, 1);
  assert.match(gaps[0], /Send Messages/);
});

test('a fully permitted server has nothing to report', () => {
  const guild = createGuild({ permissions: FULLY_PERMITTED });
  assert.deepEqual(auditSetup({ guild, action: 'kick' }), []);
  assert.deepEqual(
    auditSetup({ guild, action: 'kick', channel: createChannel(FULLY_PERMITTED) }),
    []
  );
});

test('converting a channel checks Manage Channels on that channel too', () => {
  // Conversion rewrites the channel's overwrites and topic, and Manage Channels is itself
  // overridable, so holding it server wide is not proof of holding it here.
  const guild = createGuild({ permissions: FULLY_PERMITTED });
  const channel = createChannel(FULLY_PERMITTED.filter(flag => flag !== P.ManageChannels));
  const gaps = auditSetup({ guild, action: 'kick', channel });

  assert.equal(gaps.length, 1);
  assert.match(gaps[0], /Manage Channels/);
  assert.match(gaps[0], /override/);
});

test('a permission flag name is rendered the way the Discord UI spells it', () => {
  assert.equal(humanizePermission('ManageChannels'), 'Manage Channels');
  assert.equal(humanizePermission('ReadMessageHistory'), 'Read Message History');
  // Two the UI does not spell the way the API does.
  assert.equal(humanizePermission('ModerateMembers'), 'Timeout Members');
  assert.equal(humanizePermission('ManageGuild'), 'Manage Server');
});

// --- Operator authorization and install scope ------------------------------------------

/** A stand-in for the slice of an interaction `Command.validate` reads. */
function createInteraction({ permissions = [], inGuild = true, botPermissions = [] } = {}) {
  const held = new Set(permissions);
  const botHeld = new Set(botPermissions);
  return {
    inGuild: () => inGuild,
    guild: inGuild
      ? {
          id: 'g1',
          members: { me: { permissions: { has: flag => botHeld.has(flag) } } }
        }
      : null,
    memberPermissions: inGuild ? { has: flag => held.has(flag) } : null,
    user: { id: 'user-1' },
    client: { user: { id: 'bot-1' } }
  };
}

test('/honeypot is refused for a member who does not actually hold Administrator', async () => {
  // The registered default member permission is a default an admin can override per role
  // or per channel, so it is re-checked here rather than trusted.
  const command = honeypotCommand();
  const result = await command.validate(createInteraction({ permissions: ['ManageGuild'] }));

  assert.equal(result.valid, false);
  assert.match(result.reason, /Administrator/);
});

test('/honeypot runs for an administrator', async () => {
  const command = honeypotCommand();
  const result = await command.validate(createInteraction({ permissions: ['Administrator'] }));
  assert.equal(result.valid, true);
});

test('/honeypot is refused outside a server', async () => {
  const command = honeypotCommand();
  const result = await command.validate(createInteraction({ inGuild: false }));
  assert.equal(result.valid, false);
  assert.match(result.reason, /only be used in servers/);
});

test('a declared operator permission is never skipped for want of a guild', async () => {
  // The point of the field is not resting on the registration metadata, so "there are no
  // permissions to check here" has to be a refusal rather than a free pass.
  const command = honeypotCommand();
  const interaction = createInteraction({ inGuild: false });
  // Reach past the guildOnly refusal to the authorization check itself.
  interaction.inGuild = () => true;

  const result = await command.validate(interaction);
  assert.equal(result.valid, false);
});

test('an unreadable permission set is a refusal, not an allow', async () => {
  const command = honeypotCommand();
  const interaction = createInteraction({ permissions: ['Administrator'] });
  interaction.memberPermissions = null;

  const result = await command.validate(interaction);
  assert.equal(result.valid, false);
});

test('every command is registered for server installs in server contexts only', () => {
  for (const command of ALL_COMMANDS) {
    const data = command.getRegistrationData();
    // InteractionContextType.Guild and ApplicationIntegrationType.GuildInstall.
    assert.deepEqual(data.contexts, [0], `${data.name} is registered for extra contexts`);
    assert.deepEqual(
      data.integration_types,
      [0],
      `${data.name} is registered for user installs`
    );
  }
});

test('/honeypot still carries the administrator default for the Discord UI', () => {
  const data = honeypotCommand().getRegistrationData();
  assert.equal(BigInt(data.default_member_permissions), P.Administrator);
});
