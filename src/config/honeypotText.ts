import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type APIEmbedField
} from 'discord.js';
import type { CatchRecord, HoneypotAction } from '../services/GuildConfigStore.js';
import type { SoftbanBanState } from '../services/DiscordApi.js';

/**
 * Every piece of user-facing copy the trap produces, in one place so it can be reworded
 * without touching the logic that decides when to show it.
 */

export const ACCENT = 0xff4444;

export const HIDE_ROLE_NAME = 'Hide Honeypot';
export const QUARANTINE_ROLE_NAME = 'Quarantined';

export const TRAP_TOPIC =
  'Honeypot: do not type here. Bots and scammers are removed automatically.';

/** Button IDs. The two decoys are separate IDs so both ends of the row are real buttons. */
export const BUTTON_IDS = {
  decoyLeft: 'honeypot_decoy_left',
  decoyRight: 'honeypot_decoy_right',
  stats: 'honeypot_stats',
  hide: 'honeypot_hide'
} as const;

/** Human readable label for an action. */
export function actionLabel(action: HoneypotAction): string {
  switch (action) {
    case 'quarantine':
      return 'Quarantine';
    case 'timeout':
      return '1-week Timeout';
    case 'kick':
      return 'Kick';
    case 'ban':
      return 'Ban';
  }
}

/** Past tense for a report line. */
export function actionPastTense(action: HoneypotAction | 'none'): string {
  switch (action) {
    case 'quarantine':
      return 'Quarantined';
    case 'timeout':
      return 'Timed out (1 week)';
    // A kick is carried out as a softban, so the label says they were removed and their
    // messages wiped without implying they are permanently banned.
    case 'kick':
      return 'Kicked (softban)';
    case 'ban':
      return 'Banned';
    default:
      return 'No action';
  }
}

/**
 * The trap message. Blunt and short, because the only thing that matters is that people
 * read the first line. Anyone who does not is the intended catch.
 */
export function trapEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle('DO NOT SEND MESSAGES IN THIS CHANNEL')
    .setDescription(
      [
        'Posting here, or pressing an ✖, removes you automatically. This channel is a trap for bots and scammers.',
        '',
        "**Human and want this gone?** Press **Hide Channel** and it disappears from your list."
      ].join('\n')
    )
    .setFooter({ text: 'This channel is actively monitored.' });
}

/**
 * The trap's action row, with the decoys on the outside:
 *
 *   [ ✖ ] [ Caught : N ] [ Hide Channel ] [ ✖ ]
 *
 * The red ✖ buttons are bait for anyone who presses first and reads second. The counter
 * opens the stats view, and Hide Channel is the one button with a harmless outcome.
 */
export function trapButtons(caughtCount = 0): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.decoyLeft)
      .setLabel('✖')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.stats)
      .setLabel(`Caught : ${caughtCount}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.hide)
      .setLabel('Hide Channel')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(BUTTON_IDS.decoyRight)
      .setLabel('✖')
      .setStyle(ButtonStyle.Danger)
  );
}

/**
 * The action report posted to the log channel after a catch: who, what they did, what
 * happened to them, and anything staff need to act on by hand.
 */
export function actionReportEmbed(opts: {
  userId: string;
  userTag: string;
  avatarUrl: string;
  action: HoneypotAction | 'none';
  trigger: string;
  escalated: boolean;
  failed: boolean;
  /** Softban only: the ban landed but the unban did not, so the member is still banned. */
  unbanFailed?: boolean;
  /**
   * Set when nothing was attempted because the bot could not have carried it out. Names
   * the missing permission or the role that is in the way, so the fix is one trip to
   * Server Settings rather than a guess at what "failed" meant.
   */
  blockedReason?: string;
  /**
   * Softban only: whether the leftover ban is a fact or a guess.
   *
   * 'still_banned' was confirmed against Discord. 'unknown' means the re-check itself
   * failed, so the report has to ask staff to look rather than tell them what they will
   * find. Reporting a guess as a fact is how a report stops being believed.
   */
  banState?: SoftbanBanState;
}): EmbedBuilder {
  // Both the softban and a real ban wipe 7 days of the offender's messages server wide.
  // Spelling that out stops "kick" from looking like it did less than it did.
  const purgeNote =
    opts.action === 'kick' || opts.action === 'ban'
      ? ', messages from the last 7 days purged'
      : '';

  const fields: APIEmbedField[] = [
    { name: 'User', value: `${opts.userTag}\n<@${opts.userId}> (\`${opts.userId}\`)` },
    { name: 'What they did', value: opts.trigger },
    {
      name: 'Action taken',
      value: `${actionPastTense(opts.action)}${purgeNote}${
        opts.failed && !opts.blockedReason
          ? '\n**Failed**, check my Ban Members permission and role position.'
          : ''
      }`
    }
  ];

  if (opts.blockedReason) {
    fields.push({
      name: 'Nothing was done',
      value: `${opts.blockedReason}\n\nThey were caught and counted, but no action was applied. Fix that and the next catch will land.`
    });
  }

  if (opts.escalated) {
    fields.push({
      name: 'Escalation',
      // Past tense only when it actually happened. Saying "was escalated to a full ban"
      // next to "nothing was done" is the kind of contradiction that costs staff an hour.
      value: opts.blockedReason
        ? 'Account age under 7 days, so this would have been escalated to a full ban.'
        : 'Account age under 7 days, so this was escalated to a full ban.'
    });
  }

  if (opts.unbanFailed) {
    fields.push(
      opts.banState === 'unknown'
        ? {
            name: 'Softban unban unconfirmed',
            value:
              'The unban failed and I could **not verify** whether the ban is still in place. A kick was intended, so check Server Settings > Bans and lift it if it is there.'
          }
        : {
            name: 'Softban unban failed',
            value:
              'The member is still **banned**, confirmed. A kick was intended, so lift the ban manually in Server Settings > Bans.'
          }
    );
  }

  return new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle('Honeypot: action taken')
    .setThumbnail(opts.avatarUrl)
    .addFields(fields)
    .setTimestamp();
}

/** The courtesy DM sent to someone the trap caught. */
export function offenderDmEmbed(opts: {
  action: HoneypotAction;
  guildName: string;
  trigger: string;
  escalated: boolean;
  /**
   * Set when the action did not finish cleanly. The DM must not tell someone they were
   * kicked when a leftover ban means they cannot come back, so it says what is actually
   * known and points them at the server's staff.
   */
  banState?: SoftbanBanState;
}): EmbedBuilder {
  const escalationNote = opts.escalated
    ? ' Accounts under 7 days old are banned rather than removed.'
    : '';
  const unresolvedNote =
    opts.action === 'kick' && opts.banState && opts.banState !== 'lifted'
      ? '\n\nA removal here is carried out as a temporary ban that is lifted immediately. Lifting it did not complete, so you may still be banned. If you believe this was a mistake, contact the server staff.'
      : '';
  return new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(`You were ${actionPastTense(opts.action).toLowerCase()} in ${opts.guildName}`)
    .setDescription(
      `You ${opts.trigger} in **${opts.guildName}**. That channel is a honeypot trap for bots and scammers, so the action was automatic.${escalationNote}${unresolvedNote}`
    );
}

/**
 * An operational alert for the log channel: something the bot could not finish on its own.
 *
 * Separate from the action report because it is not about a catch. It is the bot telling
 * staff that it owes somebody an unban it could not complete, which is the one failure here
 * that leaves a real person locked out of a server.
 */
export function operationalAlertEmbed(opts: {
  title: string;
  description: string;
  fields?: APIEmbedField[];
}): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(`Honeypot: ${opts.title}`)
    .setDescription(opts.description)
    .setTimestamp();
  if (opts.fields?.length) embed.addFields(opts.fields);
  return embed;
}

/** The ephemeral stats view behind the counter button. */
export function statsEmbed(opts: {
  total: number;
  breakdown: Record<string, number>;
  recent: CatchRecord[];
}): EmbedBuilder {
  const order: Array<HoneypotAction | 'none'> = ['ban', 'kick', 'timeout', 'quarantine', 'none'];
  const breakdownLines = order
    .filter(action => opts.breakdown[action])
    .map(action =>
      action === 'none'
        ? `No action: **${opts.breakdown[action]}**`
        : `${actionLabel(action as HoneypotAction)}: **${opts.breakdown[action]}**`
    );

  const recentLines = opts.recent.length
    ? opts.recent.map(record => {
        const when = record.caughtAt.slice(0, 16).replace('T', ' ');
        return `${when}: ${record.userTag} → ${actionPastTense(record.action).toLowerCase()}${
          record.escalated ? ' (escalated)' : ''
        }`;
      })
    : ['No catches yet. Patience.'];

  return new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle('Honeypot stats')
    .addFields(
      { name: 'Total caught', value: String(opts.total) },
      {
        name: 'By action',
        value: breakdownLines.length ? breakdownLines.join('\n') : 'None yet.'
      },
      { name: 'Recent catches', value: recentLines.join('\n').slice(0, 1024) }
    );
}
