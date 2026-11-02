# Honeypot release checklist

The November 2 integration preserves the commits from PRs #1–#9 and combines their
storage, registration, permissions, detection, admission, logging and startup work.
It fixes integration failures and adds regression cases for unsafe recovery, unknown
ban outcomes, failed storage, stale buttons, warning-message failures, role ownership,
configuration changes, and application-scoped command rollback.

## Validation

Run `npm ci --ignore-scripts`, then `npm test`. The test script compiles TypeScript and
runs the Node test suite without logging a client into Discord. CI tests Node 22 and 24.
`npm audit --omit=dev --audit-level=high` checks runtime dependencies. No lint tool or
browser interface exists in this repository; Discord acceptance requires a test guild.

## Deploy an existing approved gateway service

The repository contains no configured production host, deployment workflow, service ID,
or credential binding. Merging code does not demonstrate that a bot is live. Establish
the actual service and application before running a client or changing registration.

1. Stop the existing writer and retain a restricted backup of the complete `DATA_DIR`.
2. Install the reviewed commit with `npm ci --ignore-scripts` and `npm run build` on Node
   22 or 24. Preserve the persistent data directory and existing secret injection.
3. Run exactly one gateway process. Do not launch a second copy against production state.
4. Set the existing application ID, token and data directory. `REGISTER_ON_BOOT` is ignored.
5. In a controlled test guild, inspect `npm run register -- --guild <id> --dry-run`, then
   register the reviewed payload to that guild. Confirm administrator-only management,
   channel permission failures, hide-role assignment, message/button behavior, and recovery
   using consenting test accounts. Bans and softbans delete up to seven days of messages.
6. Register globally only after accepting the test-guild result. Retain registration state
   for `--rollback`; `--clear --guild <id>` also retains its prior payload for rollback.
7. Start the service and verify login, startup reconciliation, recovery results, and one
   controlled interaction. Check unresolved recovery records and the host's process logs.

To roll back code, stop the writer, restore the prior reviewed build, and retain state.
Do not restore an older pending-action journal over newer recovery evidence. Registration
rollback is separate from code rollback. Directory listings, portal changes, new credentials,
new grants and a new hosting service are separate operations.

## Limits that remain explicit

- Single-process file storage; no replicas or distributed locking. Remote Discord operations
  are not transactions. Backups can restore the preceding state, so drill restoration with
  test data before production use.
- One admitted workflow per guild and four globally; ten per guild per minute, one per
  second, and a ten-second user cooldown. Rejected events are not queued and may expire.
  These are guardrails, not a measured hosting-capacity claim.
- Raw ban/unban/status REST requests have ten-second deadlines. They do not share a global
  scheduler with discord.js. Long unban deadlines persist; deferred recovery runs on restart.
- An uncertain ban retains evidence. Recovery only lifts a ban whose reason includes the
  exact journal marker; unrelated, ambiguous or legacy bans require staff review. Discord
  does not provide an atomic compare-and-unban endpoint, so operators must avoid changing
  the same ban while recovery is running. See the [Discord ban API](https://github.com/discord/discord-api-docs/blob/main/developers/resources/guild.mdx#get-guild-ban).
- Quarantine checks current effective channel visibility after role assignment. Changed or
  newly created channels need operator review; quarantine is not continuous containment.
- No host health endpoint or out-of-band alert delivery is configured. Discord alerts need
  a configured log channel. Failed permission checks are not deployment smoke evidence.

## Privacy facts for the product page

Detection reads event metadata, not message bodies. Only Guilds and GuildMessages intents
are requested. Stored records include guild/channel/role/user IDs, user tags, action/source
and timestamps, recent catch history (50 per guild), lifetime counters, registration payloads,
and pending recovery evidence. Live guild settings/history are removed on departure;
backups and unresolved recovery evidence can outlive departure. Host log and external
backup retention depend on the operator. Do not claim zero personal data, automatic removal
of all backups, or unlimited capacity.
