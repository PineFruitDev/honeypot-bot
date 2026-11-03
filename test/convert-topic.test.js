// What conversion does to a borrowed channel's topic, and what removal gives back.
//
// The topic is the one piece of the channel's own content provisioning rewrites, and
// `/honeypot remove` answers "The channel is back to normal, minus the trap message". That
// claim is only true if the original was recorded at conversion time: conversion is the last
// moment it can be read at all, and removal deletes the config immediately afterwards, so a
// topic not restored here is gone from Discord and from the bot both.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ChannelType, Collection } from 'discord.js';
import { GuildConfigStore } from '../dist/services/GuildConfigStore.js';
import { HoneypotService } from '../dist/services/HoneypotService.js';
import { TRAP_TOPIC } from '../dist/config/honeypotText.js';

const GUILD = '111111111111111111';
const EVERYONE = 'everyone-role';
const HIDE_ROLE = { id: 'hide-role' };

let dataDir;
/** Every value passed to `setTopic`, in order, so a lost topic is visible as a value. */
let topics;

/**
 * A stand-in for the slice of a guild that conversion and un-conversion touch.
 *
 * `channel.topic` tracks the writes, because that is what an admin sees afterwards.
 */
function createGuild(topic) {
  topics = [];

  const channel = {
    id: 'trap-1',
    type: ChannelType.GuildText,
    topic,
    permissionOverwrites: {
      cache: new Collection(),
      edit: async () => {},
      delete: async () => {}
    },
    messages: { delete: async () => {} },
    send: async () => ({ id: 'sticky-1' }),
    setTopic: async next => {
      topics.push(next);
      channel.topic = next;
    },
    delete: async () => {
      throw new Error('a converted channel must never be deleted');
    }
  };

  return {
    id: GUILD,
    roles: { everyone: { id: EVERYONE }, cache: new Collection() },
    channels: { cache: new Collection([['trap-1', channel]]) }
  };
}

const channelOf = guild => guild.channels.cache.get('trap-1');

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'honeypot-topic-'));
  GuildConfigStore.instance = null;
  await GuildConfigStore.init(dataDir);
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('converting a channel records the topic it replaced', async () => {
  const guild = createGuild('General chat. Rules live in #rules.');

  const result = await HoneypotService.convertExisting(guild, HIDE_ROLE, channelOf(guild), 'kick');

  assert.equal(result.ok, true);
  assert.equal(channelOf(guild).topic, TRAP_TOPIC, 'the trap warning is the visible topic');
  assert.equal(
    GuildConfigStore.getInstance().getGuild(GUILD).previousTopic,
    'General chat. Rules live in #rules.'
  );
});

test('removing the honeypot puts the original topic back', async () => {
  // The regression guard. Removal used to blank the topic unconditionally, so an admin who
  // converted a channel and later changed their mind was told it was back to normal while
  // their own description of it had been thrown away.
  const guild = createGuild('Archive of the old announcements channel.');
  await HoneypotService.convertExisting(guild, HIDE_ROLE, channelOf(guild), 'kick');

  const result = await HoneypotService.remove(guild);

  assert.deepEqual(result, { removed: true, converted: true });
  assert.equal(channelOf(guild).topic, 'Archive of the old announcements channel.');
  assert.equal(topics.at(-1), 'Archive of the old announcements channel.');
  // The config is gone, so this is the only chance there was to do it.
  assert.equal(GuildConfigStore.getInstance().getGuild(GUILD), undefined);
});

test('a channel that had no topic is given none back, not an empty one', async () => {
  const guild = createGuild(null);
  await HoneypotService.convertExisting(guild, HIDE_ROLE, channelOf(guild), 'kick');
  assert.equal(GuildConfigStore.getInstance().getGuild(GUILD).previousTopic, undefined);

  await HoneypotService.remove(guild);

  assert.equal(channelOf(guild).topic, null);
  assert.equal(topics.at(-1), null);
});

test('a config written before topics were recorded still un-converts', async () => {
  // Records from an older build carry no previousTopic. They must not throw, and they get
  // the old behaviour, because there is genuinely nothing to restore.
  const guild = createGuild('Something an older build already overwrote.');
  const store = GuildConfigStore.getInstance();
  await store.setTrap(GUILD, {
    channelId: 'trap-1',
    hideRoleId: HIDE_ROLE.id,
    createdByBot: false,
    messageId: 'sticky-1',
    action: 'kick'
  });

  const result = await HoneypotService.remove(guild);

  assert.deepEqual(result, { removed: true, converted: true });
  assert.equal(channelOf(guild).topic, null);
});
