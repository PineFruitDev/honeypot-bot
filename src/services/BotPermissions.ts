import { PermissionFlagsBits, type Guild, type GuildBasedChannel, type GuildMember, type Role } from 'discord.js';
import type { HoneypotAction } from './GuildConfigStore.js';

/**
 * What the bot needs to be able to do, and whether it can actually do it here.
 *
 * Two things make a guild-level permission check a lie. A channel overwrite can take away
 * what the role grants, so holding Send Messages server wide says nothing about the trap
 * channel. And Discord's role hierarchy sits on top of every permission: a bot with Ban
 * Members still cannot touch someone whose highest role is above its own. Both failures
 * surface from the API as a flat 50013, long after an admin has been told setup worked.
 *
 * So the checks live here, they are run before the action rather than after it, and every
 * one of them returns the sentence an admin would need to fix it.
 */

/** A permission the bot needs, paired with the label Discord shows in its own UI. */
export type RequiredPermission = readonly [bigint, string];

const VIEW_CHANNEL: RequiredPermission = [PermissionFlagsBits.ViewChannel, 'View Channel'];
const SEND_MESSAGES: RequiredPermission = [PermissionFlagsBits.SendMessages, 'Send Messages'];
const EMBED_LINKS: RequiredPermission = [PermissionFlagsBits.EmbedLinks, 'Embed Links'];
const READ_HISTORY: RequiredPermission = [
  PermissionFlagsBits.ReadMessageHistory,
  'Read Message History'
];
const MANAGE_MESSAGES: RequiredPermission = [
  PermissionFlagsBits.ManageMessages,
  'Manage Messages'
];
const MANAGE_CHANNELS: RequiredPermission = [
  PermissionFlagsBits.ManageChannels,
  'Manage Channels'
];
const MANAGE_ROLES: RequiredPermission = [PermissionFlagsBits.ManageRoles, 'Manage Roles'];
const BAN_MEMBERS: RequiredPermission = [PermissionFlagsBits.BanMembers, 'Ban Members'];
const MODERATE_MEMBERS: RequiredPermission = [
  PermissionFlagsBits.ModerateMembers,
  'Timeout Members'
];

/**
 * Server-wide permissions provisioning needs: a channel to create or edit, and a role to
 * create and hand out. Deliberately not Administrator, which would grant all of the below
 * plus everything the bot has no business holding.
 */
export const SETUP_PERMISSIONS: readonly RequiredPermission[] = [MANAGE_CHANNELS, MANAGE_ROLES];

/**
 * Effective permissions the bot needs inside the trap channel.
 *
 * Manage Messages is on the list because deleting the spam is the first thing a catch
 * does, and deleting somebody else's message needs it. Read Message History is here
 * because converting a channel checks for human activity first, and that check failing
 * open is how a channel people use becomes a trap.
 */
export const TRAP_CHANNEL_PERMISSIONS: readonly RequiredPermission[] = [
  VIEW_CHANNEL,
  SEND_MESSAGES,
  EMBED_LINKS,
  READ_HISTORY,
  MANAGE_MESSAGES
];

/**
 * What converting an existing channel needs *in that channel*.
 *
 * Manage Channels is on this list and not on the trap list, because conversion rewrites
 * the channel's overwrites and topic, and Manage Channels is itself overridable per
 * channel. Holding it server wide is not proof of holding it here.
 */
export const CONVERSION_CHANNEL_PERMISSIONS: readonly RequiredPermission[] = [
  ...TRAP_CHANNEL_PERMISSIONS,
  MANAGE_CHANNELS
];

/** Effective permissions the bot needs inside the log channel: post an embed, nothing more. */
export const LOG_CHANNEL_PERMISSIONS: readonly RequiredPermission[] = [
  VIEW_CHANNEL,
  SEND_MESSAGES,
  EMBED_LINKS
];

/**
 * What the action being taken right now needs, and nothing more.
 *
 * Ban Members covers kick, because a kick is carried out as a softban. It is deliberately
 * *not* on the timeout or quarantine lists: escalation is resolved into the action before
 * this is consulted, so an action that is still `timeout` by then belongs to an account
 * over seven days old and no ban is involved. Requiring it anyway would stop a
 * timeout-only server from acting on anyone at all. The escalation path is covered by
 * `escalationWarning`, which advises at setup instead of blocking at the catch.
 *
 * Kick Members is on no list: nothing here uses Discord's kick.
 */
export function permissionsForAction(action: HoneypotAction): readonly RequiredPermission[] {
  switch (action) {
    case 'ban':
    case 'kick':
      return [BAN_MEMBERS];
    case 'timeout':
      return [MODERATE_MEMBERS];
    case 'quarantine':
      return [MANAGE_ROLES];
  }
}

/**
 * The escalation rule bans an account under seven days old whatever the configured action
 * is, and the trap buttons always kick, so Ban Members is worth having even on a timeout
 * or quarantine server.
 *
 * Advice, not a gate. A server that genuinely does not want the bot banning anyone keeps
 * a working timeout trap; it just will not escalate, and this says so at setup rather
 * than leaving it to be discovered from a report.
 */
export function escalationWarning(guild: Guild, action: HoneypotAction): string | null {
  if (action === 'ban' || action === 'kick') return null;
  if (!missingGuildPermissions(guild, [BAN_MEMBERS]).length) return null;
  return 'Without **Ban Members** I cannot escalate: accounts under 7 days old, and anyone who presses a trap button, will be left alone. Grant it if you want the escalation rule to work.';
}

/**
 * Server-wide permissions the bot is missing, by label.
 *
 * An empty list when the bot's own member object is not cached means "nothing proven
 * missing", not "all present". Every caller treats a gap as a reason to refuse, so the
 * unknown case has to fall through to the API rather than invent a refusal.
 */
export function missingGuildPermissions(
  guild: Guild,
  required: readonly RequiredPermission[]
): string[] {
  const me = guild.members.me;
  if (!me) return [];
  return required.filter(([flag]) => !me.permissions.has(flag)).map(([, label]) => label);
}

/**
 * Effective permissions the bot is missing *in one channel*, overwrites included.
 *
 * This is the check a guild-level one cannot stand in for: `permissionsFor` resolves the
 * role grant against every overwrite on the channel, which is where a trap that looked
 * fine at setup turns into a bot that cannot delete the spam it just caught.
 */
export function missingChannelPermissions(
  guild: Guild,
  channel: GuildBasedChannel,
  required: readonly RequiredPermission[]
): string[] {
  const me = guild.members.me;
  if (!me) return [];
  const effective = channel.permissionsFor(me);
  if (!effective) return [];
  return required.filter(([flag]) => !effective.has(flag)).map(([, label]) => label);
}

/**
 * Why the bot cannot assign or edit this role, or null if it can.
 *
 * Both failure modes are hierarchy, not permission: a role above the bot's own is
 * untouchable even with Manage Roles, and a role another integration owns is untouchable
 * by anyone.
 */
export function roleHierarchyIssue(guild: Guild, role: Role): string | null {
  if (role.managed) {
    return `**${role.name}** is managed by another integration, so no bot can assign it. Use a plain role instead.`;
  }
  const me = guild.members.me;
  if (!me) return null;
  if (me.roles.highest.position <= role.position) {
    return `**${role.name}** sits at or above my own highest role, so Discord will not let me assign it. Move my role above it in Server Settings > Roles.`;
  }
  return null;
}

/**
 * Why the bot cannot moderate this member, or null if it can.
 *
 * Checked before the action so the report says "my role is below theirs" instead of
 * "failed", which is the difference between an admin fixing it and an admin filing a bug.
 */
export function memberHierarchyIssue(guild: Guild, member: GuildMember | null): string | null {
  if (!member) return null;
  if (member.id === guild.ownerId) {
    return 'They own this server, so no moderation action can apply to them.';
  }
  const me = guild.members.me;
  if (!me) return null;
  if (member.id === me.id) return 'That is me.';
  if (me.roles.highest.position <= member.roles.highest.position) {
    return 'Their highest role sits at or above mine, so Discord will not let me act on them. Move my role higher in Server Settings > Roles.';
  }
  return null;
}

/**
 * Everything standing between the bot and carrying out `action` on `member`, or null.
 *
 * Member hierarchy is only checked when the member is known. The message and button paths
 * both carry one, so in practice it always is; when it is not, the action still goes to
 * the API rather than being refused on a guess.
 */
export function actionBlockedReason(
  guild: Guild,
  action: HoneypotAction,
  member: GuildMember | null
): string | null {
  const missing = missingGuildPermissions(guild, permissionsForAction(action));
  if (missing.length) {
    return `I do not have the **${missing.join('**, **')}** permission in this server.`;
  }
  return memberHierarchyIssue(guild, member);
}

/**
 * Every permission and hierarchy gap that would stop `/honeypot setup` from working, as
 * ready-to-print lines.
 *
 * All of them at once, on purpose. Reporting one gap per attempt turns setup into four
 * round trips through Server Settings.
 */
export function auditSetup(opts: {
  guild: Guild;
  action: HoneypotAction;
  /** Set when converting an existing channel; omitted when the bot creates its own. */
  channel?: GuildBasedChannel | null;
}): string[] {
  const { guild, action, channel } = opts;
  const gaps: string[] = [];

  const server = [
    ...missingGuildPermissions(guild, SETUP_PERMISSIONS),
    ...missingGuildPermissions(guild, permissionsForAction(action)),
    // A channel the bot creates gets overwrites for @everyone and the hide role only, and
    // none for the bot itself, so whatever it needs in there it has to hold server wide.
    // Required on the conversion path too, which is stricter than strictly necessary: an
    // overwrite on the target channel could supply a permission the role lacks. Refusing
    // that case is the deliberate trade, because a trap whose permissions depend on one
    // channel's overwrites breaks the moment somebody tidies them up.
    ...missingGuildPermissions(guild, TRAP_CHANNEL_PERMISSIONS)
  ];
  const uniqueServer = [...new Set(server)];
  if (uniqueServer.length) {
    gaps.push(
      `I need the **${uniqueServer.join(
        '**, **'
      )}** permission in this server. Grant it to my role in Server Settings > Roles.`
    );
  }

  if (channel) {
    const inChannel = missingChannelPermissions(guild, channel, CONVERSION_CHANNEL_PERMISSIONS)
      // Already reported above as a server-wide gap; saying it twice reads like two problems.
      .filter(label => !uniqueServer.includes(label));
    if (inChannel.length) {
      gaps.push(
        `I need the **${inChannel.join('**, **')}** permission in <#${
          channel.id
        }>. A channel permission override is taking it away, even though my role has it.`
      );
    }
  }

  return gaps;
}

/**
 * Turn a `PermissionsString` such as `ManageChannels` into `Manage Channels`.
 *
 * Only for error copy, and only roughly Discord's own wording: a few flags are spelled
 * differently in the settings UI than in the API, so those are spelled out rather than
 * split on capitals.
 */
export function humanizePermission(permission: string): string {
  const UI_NAMES: Record<string, string> = {
    ModerateMembers: 'Timeout Members',
    ManageGuild: 'Manage Server',
    ManageGuildExpressions: 'Manage Expressions'
  };
  return UI_NAMES[permission] ?? permission.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}
