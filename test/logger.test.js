// Tests for the logger: that levels filter, that correlation ids ride along on every line
// an event produces, and above all that neither a token nor a user's text can reach stdout.
//
// The redaction tests are the ones that matter. A regression there leaks a bot token into a
// host's log aggregator, which is a credential rotation rather than a bug fix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Logger,
  REDACTED,
  describeContent,
  formatArg,
  formatEntry,
  interactionCorrelation,
  isEnabled,
  messageCorrelation,
  redact,
  resolveLevel
} from '../dist/services/Logger.js';

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const USER = '333333333333333333';
const INTERACTION = '444444444444444444';

/**
 * A bot-token-shaped string. The segments are invented, so this is not a credential, but it
 * is assembled at runtime rather than written out: a literal in this shape trips secret
 * scanners, and a test fixture is not worth a push protection override.
 */
const FAKE_TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GhIjKl', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ01234'].join('.');

/** A logger that collects its lines instead of printing them. */
function capturing(options = {}) {
  const lines = [];
  const logger = new Logger({
    level: 'debug',
    sink: (level, line) => lines.push({ level, line }),
    ...options
  });
  return { logger, lines };
}

// --- levels ---------------------------------------------------------------------------

test('a level threshold drops everything below it', () => {
  const { logger, lines } = capturing({ level: 'warn' });

  logger.debug('dropped');
  logger.info('dropped');
  logger.warn('kept');
  logger.error('kept');

  assert.deepEqual(
    lines.map(entry => entry.level),
    ['warn', 'error']
  );
});

test('silent drops every level', () => {
  const { logger, lines } = capturing({ level: 'silent' });

  logger.debug('x');
  logger.info('x');
  logger.warn('x');
  logger.error('x');

  assert.equal(lines.length, 0);
});

test('isEnabled compares against the threshold, not the call order', () => {
  assert.equal(isEnabled('error', 'debug'), true);
  assert.equal(isEnabled('debug', 'debug'), true);
  assert.equal(isEnabled('info', 'warn'), false);
  assert.equal(isEnabled('error', 'silent'), false);
});

test('LOG_LEVEL wins, development implies debug, and a bad value falls back to info', () => {
  assert.equal(resolveLevel({ LOG_LEVEL: 'warn' }), 'warn');
  assert.equal(resolveLevel({ LOG_LEVEL: ' WARN ' }), 'warn');
  // An explicit level beats the NODE_ENV shorthand.
  assert.equal(resolveLevel({ LOG_LEVEL: 'error', NODE_ENV: 'development' }), 'error');
  assert.equal(resolveLevel({ NODE_ENV: 'development' }), 'debug');
  assert.equal(resolveLevel({ NODE_ENV: 'production' }), 'info');
  // A typo must not silence the bot.
  assert.equal(resolveLevel({ LOG_LEVEL: 'verbose' }), 'info');
  assert.equal(resolveLevel({}), 'info');
});

// --- token redaction ------------------------------------------------------------------

test('a bot-token-shaped string never survives a log line', () => {
  const { logger, lines } = capturing();

  logger.error(`login failed with ${FAKE_TOKEN}`);

  assert.ok(!lines[0].line.includes(FAKE_TOKEN));
  assert.ok(lines[0].line.includes(REDACTED));
});

test('the configured token is matched literally, whatever shape it has', () => {
  const unusual = 'not-token-shaped-but-still-the-secret-0123456789';
  const out = redact(`Authorization header was ${unusual}`, { DISCORD_TOKEN: unusual });

  assert.ok(!out.includes(unusual));
  assert.ok(out.includes(REDACTED));
});

test('a short placeholder token does not shred unrelated text', () => {
  // A dev env with DISCORD_TOKEN=x must not turn every line into redaction markers.
  const out = redact('the quick brown fox', { DISCORD_TOKEN: 'x' });

  assert.equal(out, 'the quick brown fox');
});

test('a bare auth scheme keeps the scheme and loses the credential', () => {
  // Worth keeping `Bot` vs `Bearer`: it says which credential a failing request used.
  const out = redact(`sent header Bot ${FAKE_TOKEN}`);

  assert.ok(!out.includes(FAKE_TOKEN));
  assert.ok(out.includes('Bot [redacted]'));
});

test('a named Authorization header collapses entirely', () => {
  // The header name matches the credential-key pattern, so the value goes wholesale. That
  // is stronger than keeping the scheme, and the scheme is not worth a carve-out for it.
  const out = redact(`Authorization: Bot ${FAKE_TOKEN}`);

  assert.ok(!out.includes(FAKE_TOKEN));
  assert.equal(out, `Authorization: ${REDACTED}`);
});

test('credential-shaped assignments are redacted whatever the separator', () => {
  assert.ok(!redact('DISCORD_TOKEN=hunter2hunter2').includes('hunter2'));
  assert.ok(!redact('{"client_secret": "hunter2hunter2"}').includes('hunter2'));
  assert.ok(!redact('api_key: hunter2hunter2').includes('hunter2'));
  assert.ok(!redact('password=hunter2hunter2').includes('hunter2'));
});

test('a webhook url keeps its id and loses its token', () => {
  const out = redact('posting to https://discord.com/api/webhooks/123456789/sUpErSeCrEtWebhookToken');

  assert.ok(out.includes('123456789'));
  assert.ok(!out.includes('sUpErSeCrEtWebhookToken'));
});

test('redaction leaves ordinary text and snowflakes alone', () => {
  // Ids are the whole point of the logger, so they must pass through untouched, and nothing
  // version-shaped should trip the three-segment token pattern.
  const line = `caught ${USER} in ${GUILD} running discord.js v14.22.1`;

  assert.equal(redact(line, {}), line);
});

test('a token buried in an error stack is redacted too', () => {
  const { logger, lines } = capturing();
  const error = new Error(`request to /api/v10/users/@me failed, sent Bot ${FAKE_TOKEN}`);

  logger.error('banMember - threw:', error);

  assert.ok(!lines[0].line.includes(FAKE_TOKEN));
  assert.ok(lines[0].line.includes('[redacted]'));
});

// --- user content redaction -----------------------------------------------------------

test('content is reduced to a length and a hash, never the text', () => {
  const described = describeContent('join my server for free nitro');

  assert.ok(!described.includes('nitro'));
  assert.match(described, /^<redacted chars=29 hash=[0-9a-f]{10}>$/);
});

test('the same content hashes alike, different content does not', () => {
  // This is what makes a flood repeating one payload visible without storing the payload.
  assert.equal(describeContent('same payload'), describeContent('same payload'));
  assert.notEqual(describeContent('payload a'), describeContent('payload b'));
});

test('absent and empty content are distinguishable and both harmless', () => {
  assert.equal(describeContent(undefined), '<none>');
  assert.equal(describeContent(null), '<none>');
  assert.equal(describeContent(''), '<empty>');
});

test('a content field is digested wherever it appears in a logged object', () => {
  const { logger, lines } = capturing();

  logger.debug('handleMessage - Trap hit', {
    author: { id: USER, username: 'FreeNitroBot' },
    message: { id: '5', content: 'click this link' }
  });

  const { line } = lines[0];
  assert.ok(!line.includes('click this link'));
  assert.ok(!line.includes('FreeNitroBot'));
  // The ids around it still come through, which is what makes the line useful.
  assert.ok(line.includes(USER));
  assert.match(line, /chars=15/);
});

test('a content field passed as a correlation field is digested as well', () => {
  const { logger, lines } = capturing();

  logger.child({ guildId: GUILD, content: 'scam text' }).info('caught');

  assert.ok(!lines[0].line.includes('scam text'));
  assert.ok(lines[0].line.includes(GUILD));
});

// --- correlation ----------------------------------------------------------------------

test('a child logger stamps its ids on every line, including later errors', () => {
  const { logger, lines } = capturing({ context: 'Bot' });
  const log = logger.child({ event: 'message', guildId: GUILD, channelId: CHANNEL });

  log.info('first');
  log.error('second', new Error('boom'));

  for (const { line } of lines) {
    assert.ok(line.includes(`guildId=${GUILD}`), line);
    assert.ok(line.includes(`channelId=${CHANNEL}`), line);
  }
  assert.ok(lines[0].line.includes('[Bot]'));
});

test('children merge onto their parent and do not mutate it', () => {
  const { logger } = capturing({ fields: { event: 'message' } });
  const child = logger.child({ guildId: GUILD });

  assert.deepEqual(child.getFields(), { event: 'message', guildId: GUILD });
  assert.deepEqual(logger.getFields(), { event: 'message' });
});

test('absent ids are omitted rather than printed as undefined', () => {
  const { logger, lines } = capturing();

  logger.child({ guildId: GUILD, channelId: undefined, interactionId: null }).info('x');

  assert.ok(lines[0].line.includes(`guildId=${GUILD}`));
  assert.ok(!lines[0].line.includes('undefined'));
  assert.ok(!lines[0].line.includes('null'));
});

test('message correlation pulls the guild, channel, message and user ids', () => {
  const fields = messageCorrelation({
    id: '5',
    channelId: CHANNEL,
    guild: { id: GUILD },
    author: { id: USER },
    content: 'never logged'
  });

  assert.deepEqual(fields, {
    event: 'message',
    guildId: GUILD,
    channelId: CHANNEL,
    messageId: '5',
    userId: USER
  });
});

test('interaction correlation carries the interaction id and distinguishes commands', () => {
  const button = interactionCorrelation({
    id: INTERACTION,
    channelId: CHANNEL,
    guild: { id: GUILD },
    user: { id: USER },
    customId: 'honeypot_hide'
  });
  assert.equal(button.event, 'interaction');
  assert.equal(button.interactionId, INTERACTION);
  assert.equal(button.customId, 'honeypot_hide');

  const command = interactionCorrelation({
    id: INTERACTION,
    guildId: GUILD,
    user: { id: USER },
    commandName: 'honeypot'
  });
  assert.equal(command.event, 'command');
  assert.equal(command.guildId, GUILD);
  assert.equal(command.commandName, 'honeypot');
});

// --- formatting -----------------------------------------------------------------------

test('the text format keeps the shape the bot already printed', () => {
  const line = formatEntry(
    {
      timestamp: '2026-11-01T00:00:00.000Z',
      level: 'info',
      component: 'Bot',
      message: 'handleCommand - Executed',
      fields: { guildId: GUILD },
      args: []
    },
    {}
  );

  assert.equal(line, `[2026-11-01T00:00:00.000Z] [INFO] [Bot] handleCommand - Executed {guildId=${GUILD}}`);
});

test('LOG_FORMAT=json emits one parseable object per line with the ids at the top level', () => {
  const line = formatEntry(
    {
      timestamp: '2026-11-01T00:00:00.000Z',
      level: 'warn',
      component: 'Bot',
      message: 'handleCommand - Unknown command',
      fields: { guildId: GUILD, interactionId: INTERACTION },
      args: ['extra']
    },
    { LOG_FORMAT: 'json' }
  );

  assert.deepEqual(JSON.parse(line), {
    timestamp: '2026-11-01T00:00:00.000Z',
    level: 'warn',
    component: 'Bot',
    message: 'handleCommand - Unknown command',
    guildId: GUILD,
    interactionId: INTERACTION,
    details: ['extra']
  });
});

test('a circular object is logged rather than throwing', () => {
  // A discord.js structure is full of back references, so this is the realistic case.
  const guild = { id: GUILD };
  guild.self = guild;

  assert.doesNotThrow(() => formatArg(guild, {}));
  assert.ok(formatArg(guild, {}).includes(GUILD));
});

test('an undefined argument does not add a stray token to the line', () => {
  const { logger, lines } = capturing();

  // `logger.error('failed:', error)` with nothing thrown is a real call shape.
  logger.error('start - Failed to start bot:', undefined);

  assert.equal(lines[0].line.trim().endsWith('Failed to start bot:'), true);
});

// --- the single-sink guarantee --------------------------------------------------------

test('no source file outside the logger writes to the console directly', async () => {
  // The redaction guarantees above are only worth anything if every line goes through the
  // logger. This walks the real source tree so a new direct `console.log` fails the build.
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

  async function filesIn(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const found = await Promise.all(
      entries.map(async entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return filesIn(full);
        return entry.name.endsWith('.ts') ? [full] : [];
      })
    );
    return found.flat();
  }

  const offenders = [];
  for (const file of await filesIn(src)) {
    if (path.basename(file) === 'Logger.ts') continue;
    const source = await fs.readFile(file, 'utf8');
    if (/\bconsole\s*\./.test(source)) offenders.push(path.relative(src, file));
  }

  assert.deepEqual(offenders, []);
});
