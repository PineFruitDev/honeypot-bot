# honeypot-bot

Catch spam bots and scammers before your members have to report them. The bot builds a channel that exists only to be posted in, and removes anyone who does. Real people get a button that makes it disappear.

Built on the [TSTemplateBot](https://github.com/PineFruitDev/TSTemplateBot) architecture: command class pattern, single source of truth, full TypeScript.

## Features

- **Trap Channel**: Visible to everyone, deliberately open to posting. Bots that spray every channel they can see walk straight into it
- **Bait Buttons**: The trap message is flanked by two red ✖ buttons. Pressing one is treated exactly like posting
- **Hide For Humans**: One green button hides the channel for that member and does nothing else. No ban, no fuss
- **Four Actions**: Kick, ban, one-week timeout, or quarantine, picked per server
- **Kick Means Softban**: A kick is carried out as a ban with a 7-day purge followed by a verified unban, so the member is removed *and* their spam is wiped from every channel, without a permanent ban
- **Young Account Escalation**: Accounts under seven days old are banned no matter what the configured action is, because spam rings cycle throwaways
- **Exemptions**: The server owner is always safe, and you can exempt any user or role
- **Action Reports**: An embed to your log channel for every catch: who, what they did, what happened, and anything left for you to do by hand
- **Sticky Trap**: The trap message is re-posted after each catch with a live counter, so it never scrolls out of sight
- **Hide From Roles**: Keep the trap out of your staff's channel list entirely
- **No Privileged Intents**: Runs on Guilds and Guild Messages, so there is nothing to request in the Developer Portal, and no Administrator permission either
- **Checks Before It Acts**: Channel overrides are verified at setup, and role position before every catch, so staff get "my role is below theirs" instead of the word "failed"
- **Multi-Server**: Fully per-guild. One instance serves any number of servers, each with its own trap and settings
- **Production Ready**: Environment validation, contextual logging, restart-safe config, and a test suite

## How It Works

The trap is an ordinary text channel with two permission overwrites: `@everyone` gets View and Read History, and the **Hide Honeypot** role is denied View. Send Messages is deliberately left alone, because the whole point is that posting is possible.

The bot watches `MessageCreate`. Anything posted in a trap channel by anyone other than itself is a catch: the message is deleted first to blunt a flood, then the configured action runs. Message Content is never requested, since knowing *that* someone posted is enough.

**A kick is a softban.** Discord's kick removes the member but leaves their messages everywhere. A ban with `delete_message_seconds` set to seven days removes them *and* wipes the spam server wide, so the bot bans, lets the purge land, then lifts the ban. The net effect is a kick that also cleans up.

That unban is the part worth being careful about. If it fails, the member stays permanently banned while every log says "kicked", so the bot:

- honours Discord's `retry_after` instead of retrying straight back into the same rate-limit window, which is what turns one transient 429 into a member who never gets unbanned;
- keeps the real HTTP status, Discord error code and `retry_after` in the log line, rather than collapsing every failure into the word "error";
- **checks whether the ban is actually still there** before telling you the member is still banned, so you are never sent to Server Settings > Bans for a ban that is not there.

## Quick Start

### 1. Setup

```bash
git clone <your-repo>
cd honeypot-bot
npm install
cp .env.example .env
```

### 2. Configure

Edit `.env` with your bot credentials:

```env
DISCORD_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_bot_client_id_here
DEVELOPER_IDS=your_user_id_here  # Optional
NODE_ENV=development             # Optional
DATA_DIR=data                    # Optional
DEV_GUILD_ID=your_test_guild_id  # Optional, but required to register commands outside production
LOG_LEVEL=info                   # Optional
LOG_FORMAT=text                  # Optional
```

> **Required Discord setup:** invite the bot with the scopes and permissions in [Permissions and intents](#permissions-and-intents), and place its role **above** the members it will be acting on. No privileged intents are needed, and the bot never asks for Administrator.

### 3. Register the commands

Starting the bot does not register anything. Registration is a separate step, because it is a bulk
overwrite: it replaces the whole command set for whatever it is pointed at.

```bash
npm run register -- --guild          # Your DEV_GUILD_ID, visible immediately, only there
npm run register -- --dry-run        # Print what would change, call nothing
npm run register                     # The target NODE_ENV implies: global in production
```

With `NODE_ENV=production` the default target is global, which is every server the bot is in. With
anything else it is `DEV_GUILD_ID`, and the script refuses to run rather than quietly going global.

### 4. Deploy

```bash
npm run dev        # Build and start
```

### 5. Arm the trap

```
/honeypot setup
/honeypot config log-channel:#mod-log
```

## Commands

- `/honeypot setup` - Create the trap channel, or convert one that already exists
- `/honeypot config` - Change the action, log channel, hidden roles and exemptions
- `/honeypot status` - Show the current settings
- `/honeypot stats` - Total caught, a breakdown by action, and recent catches
- `/honeypot remove` - Tear the trap down and forget the settings
- `/ping` - Basic ping/pong with latency
- `/help` - Auto-generated help system

`/honeypot` is limited to administrators.

### Setup options

| Option | Description |
|--------|-------------|
| `action` | What happens to someone the trap catches. Defaults to Kick |
| `channel` | Convert this existing channel instead of creating a new one |
| `name` | Name for a newly created trap channel. Defaults to `do-not-type-here` |

Setup refuses two things on purpose. It will not trap your **system or rules channel**, because those are where members are told to post, and it will not convert a channel with **recent messages from real people**, because that channel is still in use. Both would remove members for behaving normally.

## Actions

| Action | What it does |
|--------|--------------|
| `kick` | Softban: ban with a 7-day purge, then unban. Removes them and wipes their messages. They can rejoin |
| `ban` | Permanent ban with a 7-day purge |
| `timeout` | One-week Discord timeout. They stay in the server but cannot speak |
| `quarantine` | Applies a **Quarantined** role. On first use the bot creates the role and denies it View and Send on every channel it can manage, so the role actually contains |

Whatever you pick, an account **under seven days old** is banned instead. The trap buttons always kick rather than applying the configured action, so a misclick is recoverable.

## Permissions and intents

Invite the bot with two scopes, `bot` and `applications.commands`, and nothing else. **Do not grant Administrator.** The list below is everything the bot uses, and it is shorter than Administrator by design: a trap channel is not a reason to hand a bot the keys to the server.

| Permission | What needs it |
|------------|---------------|
| View Channel | Seeing the trap and the log channel at all |
| Send Messages | The sticky trap message, and the action report |
| Embed Links | Both of those are embeds, and without this they post as nothing |
| Read Message History | The safety check that refuses to convert a channel people are still using. Required either way, so a converted channel can be checked |
| Manage Messages | Deleting the spam. Removing somebody else's message needs this specifically |
| Manage Channels | Creating the trap channel, setting its topic, writing its overwrites |
| Manage Roles | Creating and handing out **Hide Honeypot**, and **Quarantined** if you use it |
| Ban Members | Bans, the softban a kick is carried out as, and the young-account escalation |
| Timeout Members | The Timeout action only. Leave it off if you never use timeouts. Discord's API calls this `ModerateMembers` |

**Kick Members is not needed.** The `kick` action is carried out as a ban with a purge followed by an unban, so Discord's own kick is never called.

**Ban Members is worth granting even on a Timeout or Quarantine server**, because an account under seven days old is escalated to a ban whatever the configured action is, and the trap buttons always kick. It is not required: without it a timeout trap still times people out, it just will not escalate, and setup tells you so rather than leaving you to find out from a report.

All of these have to be held by the bot's **role**, not just granted on the trap channel. A channel the bot creates gets overwrites for `@everyone` and the hide role only, and none for the bot itself, so setup refuses a role that is short of any of them. You can still tighten things with channel overrides on *other* channels; what you cannot do is grant them on the trap channel alone and leave the role without them.

Quarantine reaches furthest: locking the role down writes a deny overwrite on every channel the bot can manage, so Manage Channels has to be broad for it to contain anyone.

### What gets checked, and when

A server-wide permission check is not proof the bot can act. A channel override can take back what the role grants, and Discord's role hierarchy sits above every permission, so a bot with Ban Members still cannot touch someone whose highest role outranks its own. Both come back from the API as the same error, after the attempt. So:

- `/honeypot setup` checks the server permissions, the **effective** permissions inside a channel you are converting, and whether the hide role is actually assignable. The permission gaps are reported together in one reply rather than one per attempt.
- `/honeypot config log-channel:` refuses a channel the bot cannot post an embed in, rather than letting every future report vanish.
- Each catch is checked before anything happens to anyone. If the action cannot land, the report says which permission is missing or whose role is in the way, and nobody is DMed that they were banned when they were not.
- `/honeypot` re-checks that you hold **Administrator** on every run. The registered default is a default, and a server admin can override it per role or per channel. Note the trade-off: delegating `/honeypot` to a non-administrator role through Server Settings > Integrations no longer works, because the runtime check is what decides.

### Gateway intents

The bot connects with **Guilds** and **GuildMessages**. Both are unprivileged, so there is nothing to enable in the Developer Portal and no verification threshold tied to them.

None of the three privileged intents are requested, and `src/core/intents.ts` refuses to build a client that would request one, so this cannot regress quietly:

- **Message Content** is not needed, because the trap fires on the fact that someone posted, never on what they wrote.
- **Server Members** is not needed, because the member object (roles included) arrives inside the message and interaction payloads, which is everywhere the bot reads roles.
- **Presence** is not needed, because the bot never looks at who is online.

## Project Structure

```
src/
├── core/
│   ├── Bot.ts                  # Client, trap events, button handling
│   ├── Command.ts              # Abstract command base, operator authorization
│   ├── CommandManager.ts       # Command management
│   └── intents.ts              # ← The two gateway intents, and the privileged-intent guard
├── commands/
│   ├── index.ts                # ← Command registry (single source of truth)
│   ├── HoneypotCommand.ts      # setup / config / status / stats / remove
│   ├── PingCommand.ts          # Latency check
│   └── HelpCommand.ts          # Auto-generated help
├── services/
│   ├── HoneypotService.ts      # ← Trap provisioning, overwrites, sticky message
│   ├── EnforcementService.ts   # ← Catch → action → record → report
│   ├── BotPermissions.ts       # ← Required permissions, channel and hierarchy checks
│   ├── DiscordApi.ts           # Ban/unban REST, softban retry logic
│   ├── GuildConfigStore.ts     # Per-guild config + catch history
│   ├── CommandRegistrar.ts     # Global/guild command registration, per-target fingerprints
│   ├── Environment.ts          # Config validation
│   └── Logger.ts               # Contextual logging
├── config/
│   └── honeypotText.ts         # ← All user-facing copy and embeds
├── index.ts                    # Entry point
└── register.ts                 # Command registration CLI
```

## Scripts

- `npm run build` - Compile TypeScript
- `npm run dev` - Build and run
- `npm run start` - Start production server
- `npm run register` - Register commands with Discord (see below)
- `npm test` - Run the test suite

## Registering commands

Nothing registers commands on boot. A restart does not change what Discord has, so a host that
redeploys on its own schedule cannot push a half-finished command set to every server.

```bash
npm run register -- --guild              # DEV_GUILD_ID, or --guild <id>
npm run register -- --global --dry-run   # Review the diff before a release
npm run register -- --global             # Every installation
npm run register -- --force              # Re-send even if the fingerprint matches
npm run register -- --clear --guild      # Remove the test guild's commands
npm run register -- --rollback --global  # Re-send the payload global held before
```

- **Idempotent.** The payload is fingerprinted per application and per target, so re-running against
  an unchanged command set sends nothing. The dev guild's fingerprint never makes global look up to
  date, and vice versa
- **Bulk overwrite.** A command dropped from `ALL_COMMANDS` is dropped from the target. `--dry-run`
  names what would be added, edited and removed, and the global path prints that plan before it
  sends
- **Resync with `--force`.** The fingerprint records what this bot last sent, not what Discord
  currently holds. Commands edited in the portal or registered from another machine are invisible to
  it
- **Clear the dev guild when you are done with it.** Guild commands shadow the global ones of the
  same name, so a stale test registration keeps serving an old build to the one server most likely
  to be checking the new one
- The previous payload for each target is retained in `DATA_DIR/commands.json` for `--rollback`. Back
  that file up with the rest of `DATA_DIR`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | ✅ | Bot token from Discord Developer Portal |
| `DISCORD_CLIENT_ID` | ✅ | Bot client ID from Discord Developer Portal |
| `DEVELOPER_IDS` | ❌ | Comma-separated user IDs for developer commands |
| `NODE_ENV` | ❌ | Environment mode (defaults to production); also picks the default command registration target |
| `DATA_DIR` | ❌ | Where per-guild trap config and registration state are persisted (defaults to `data`) |
| `DEV_GUILD_ID` | ❌ | Test guild for command registration when `NODE_ENV` is not `production` |
| `LOG_LEVEL` | ❌ | `debug`, `info`, `warn`, `error` or `silent` (defaults to `info`, or `debug` when `NODE_ENV=development`) |
| `LOG_FORMAT` | ❌ | `text` or `json` (defaults to `text`; `json` emits one object per line for a log shipper) |

## Logging

Every line the bot prints goes through one logger, which is what makes two guarantees hold:

- **The token never reaches stdout.** The configured token is matched literally, and anything token-shaped, any `Authorization` header and any webhook token is scrubbed as well, including out of an error's stack.
- **Message content never reaches stdout.** The bot does not request the Message Content intent, and even where text is available it is logged as a length and a per-process hash. Identical payloads hash alike while the bot is up, so a flood repeating one message is visible without the message being stored anywhere.

Each event is tagged with its correlation ids (guild, channel, message or interaction, user), on every line it produces including the ones written from a `catch`, so one catch can be followed end to end in an aggregator:

```
[2026-11-01T12:00:00.000Z] [INFO] [Bot] handleMessage - Caught {event=message guildId=… channelId=… messageId=… userId=…}
```

## Notes

- Config lives in a JSON file under `DATA_DIR`, so the trap survives restarts. Back that directory up, or mount it, if your host wipes the working directory on deploy
- The bot's role must sit **above** anyone it acts on. A doomed action is refused before it is attempted and the action report names the reason, rather than reporting a bare failure
- `src/core/Command.ts` has a `userPermissions` field. Anything a command must only ever do for an operator belongs there, so the check runs against the interaction rather than resting on the registered default
- All commands are registered for **server installs in server contexts only**, so nothing appears in DMs where there is no guild to configure and no permission model to check against
- The action report is never posted to the trap itself. It names the offender, and the trap is a public channel
- The catch history is capped at the 50 most recent per server; the lifetime counter keeps counting past that
- Other bots are fair game. Scam bots are bots, so only the server owner, the bot itself, and your configured exemptions are skipped

## License Note

This project is licensed under **[Apache 2.0](https://choosealicense.com/licenses/apache-2.0/) + the [Commons Clause](https://commonsclause.com/)**. In plain terms:

- ✅ Use it, run it, modify it, self-host it for your own community
- ✅ Fork it and build on it, with attribution and the same notice
- ❌ Sell it, or sell a hosted service whose value is mostly this bot

See the LICENSE file for the full text.

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request
