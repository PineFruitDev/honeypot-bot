# Error handling and recovery

How this bot is expected to fail. Written down because the bot moderates servers that are
not ours, where a failure is somebody else's locked-out member rather than a line of red
text we happen to notice.

Four rules, in priority order.

## 1. One guild's failure stays in that guild

Every loop that walks guilds, and every event handler, is a boundary.

- `Bot.reconcileOnBoot` reconciles each configured trap inside its own `try`. A server that
  revoked Manage Roles, deleted the trap channel or is rate limited is logged and counted,
  and the loop continues. It returns `{ total, failed }` rather than throwing.
- `Bot.recoverPendingActions` does the same per guild for leftover softbans.
- The `ClientReady` handler in `src/index.ts` guards reconciliation and recovery separately; command registration is an explicit CLI step. That handler is detached from `main`, so an unguarded throw
  inside it would surface as an unhandled rejection; and a failure in one step must not
  cost the steps after it. Incoming work waits until startup reconciliation and recovery finish.
- `Bot.routeInteraction` wraps the whole interaction path, so a handler that throws cannot
  escape into the event emitter.
- `unhandledRejection` is logged and the process keeps running. `uncaughtException` exits,
  but through the same bounded drain a signal uses.

## 2. A user who is waiting gets an answer

Every user-facing failure is ephemeral, because the trap is a public channel and an error
posted openly is a hint about how the trap is configured.

- Errors carry a 10 character correlation ID that matches the `correlationId` field on the
  log line, so staff can find the failure from what the user quotes.
- A press on a trap that has since been removed is answered rather than left to time out.
- Role-changing interactions defer before any REST work. Adding a role is a round trip,
  and Discord expires an unacknowledged interaction after three seconds. Admission limits may reject work without sending a response during a flood.

## 3. A half finished action is on disk before it is half finished

A "kick" is carried out as a ban with a seven day message purge followed by an unban. The
gap between those two halves is the only place in this bot where a crash leaves a real
person permanently banned when a removal was intended.

So `PendingActionStore` journals the intent to `DATA_DIR/pending-actions.json` before the
ban, moves it to `unban_pending` once the ban has landed, and deletes it only once the
member is known not to be banned. Writes go through a temp file and a rename, so a crash
mid-write leaves either the old journal or the new one.

At startup, `EnforcementService.recoverPendingSoftbans` runs per guild:

| Ban state on re-check | What happens |
| --- | --- |
| Not banned | The record is resolved. Nothing was owed, including when the crash happened before the ban landed. |
| Banned with this journal entry’s reason marker | The unban is retried. On success staff are told it was repaired; on failure the record stays and staff are alerted. |
| Banned with an unrelated or missing reason | No unban is attempted; staff must review ownership. |
| Unreadable | The record stays, the attempt is counted, and staff are told the state could **not** be verified. |

Automatic retries stop after `MAX_RECOVERY_ATTEMPTS` boots, and the alerts stop with them,
but the record is kept: giving up on retrying is not the same as forgetting that somebody
is banned. A record for a guild the bot has left is also kept, because deleting it would
erase the only evidence of that ban.

Success, failure and "could not tell" stay separate all the way out to the action report
and the offender DM. A report that states a guess as a fact stops being believed.

## 4. A log line never carries a credential

`Logger` is the only way anything reaches the console.

- Errors are never logged whole. `serializeError` keeps an allowlist (`name`, `message`,
  `code`, `status`, `method`, `url`, `syscall`, `errno`, a trimmed stack, bounded nested
  `cause`) and drops everything else, which is where credentials live: `fetch` and
  discord.js errors can carry the request that produced them, Authorization header
  included.
- Every string that reaches the output, including structured field values, is swept for
  token shapes, `Bot`/`Bearer` values, `KEY=value` spellings of secret-ish names, and the
  live token by exact match.
- URLs keep origin and path, never the query string.
- Startup reports that the token is present. It does not print a masked version: masking
  still publishes the ends of a live credential into every log aggregator and pasted
  screenshot the logs reach, and buys nothing over "present".
- Commands are not handed `process.env`.

## Shutdown

`Bot.stop` waits up to five seconds for catches already in progress, then flushes both
stores so a recorded catch and a journalled softban are on disk before the process exits.
`src/index.ts` wraps that in a ten second ceiling and a re-entry guard, so a host that
sends SIGTERM then SIGINT, or a stuck REST call, cannot block a restart.

## Not covered yet

- No health or readiness endpoint. What that should look like depends on the host, which is
  not chosen yet.
- Alerting is in-Discord only, to the configured log channel. There is no out-of-band
  alert, so a guild with no log channel configured gets console logs alone.
- Guild writes are atomic and failures reject. Moderation already completed is still reported if the subsequent history write fails.
- No alerting on sustained rate limiting.

Softbans are refused when the journal is missing, degraded, or cannot persist the intent.
An uncertain ban response retains the journal entry. A pre-existing ban is never knowingly
replaced by a softban, and startup recovery requires the exact journal marker in the current
ban reason before unbanning. Older records without a matching marker require staff review.
Long server retry deadlines are persisted and honored across restarts. Recovery runs at
startup, not on a background timer; unresolved records also need operator attention.
A corrupt journal remains in place and is copied to a sidecar for diagnosis, so rebooting
does not silently reset the failure. Repair it while the bot is stopped.
