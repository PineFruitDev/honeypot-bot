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
- **No Privileged Intents**: Runs on Guilds and Guild Messages, so there is nothing to request in the Developer Portal
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
REGISTER_ON_BOOT=true            # Optional
```

> **Required Discord setup:** invite the bot with **Manage Channels**, **Manage Roles**, **Ban Members**, **Moderate Members**, **View Channels** and **Send Messages**, and place its role **above** the members it will be acting on. No privileged intents are needed.

### 3. Deploy

```bash
npm run dev        # Build and start; commands register themselves on boot
```

### 4. Arm the trap

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

## Project Structure

```
src/
├── core/
│   ├── Bot.ts                  # Client, trap events, button handling
│   ├── Command.ts              # Abstract command base
│   └── CommandManager.ts       # Command management
├── commands/
│   ├── index.ts                # ← Command registry (single source of truth)
│   ├── HoneypotCommand.ts      # setup / config / status / stats / remove
│   ├── PingCommand.ts          # Latency check
│   └── HelpCommand.ts          # Auto-generated help
├── services/
│   ├── HoneypotService.ts      # ← Trap provisioning, overwrites, sticky message
│   ├── EnforcementService.ts   # ← Catch → action → record → report
│   ├── DiscordApi.ts           # Ban/unban REST, softban retry logic
│   ├── GuildConfigStore.ts     # Per-guild config + catch history
│   ├── CommandRegistrar.ts     # Boot-time command registration
│   ├── Environment.ts          # Config validation
│   └── Logger.ts               # Contextual logging
├── config/
│   └── honeypotText.ts         # ← All user-facing copy and embeds
├── index.ts                    # Entry point
└── register.ts                 # Manual command registration
```

## Scripts

- `npm run build` - Compile TypeScript
- `npm run dev` - Build and run
- `npm run start` - Start production server
- `npm run register` - Force command registration with Discord
- `npm run deploy` - Build, register, and start
- `npm test` - Run the test suite

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | ✅ | Bot token from Discord Developer Portal |
| `DISCORD_CLIENT_ID` | ✅ | Bot client ID from Discord Developer Portal |
| `DEVELOPER_IDS` | ❌ | Comma-separated user IDs for developer commands |
| `NODE_ENV` | ❌ | Environment mode (defaults to production) |
| `DATA_DIR` | ❌ | Where per-guild trap config is persisted (defaults to `data`) |
| `REGISTER_ON_BOOT` | ❌ | Register slash commands on startup (defaults to true) |

## Notes

- Config lives in a JSON file under `DATA_DIR`, so the trap survives restarts. Back that directory up, or mount it, if your host wipes the working directory on deploy
- The bot's role must sit **above** anyone it acts on. A doomed ban fails loudly in the action report rather than silently
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
