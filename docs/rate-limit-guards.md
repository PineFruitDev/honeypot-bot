# Rate limit and abuse guard lane

Gateway admission now permits one concurrent workflow per guild and four globally,
with no waiting queue. Each guild admits at most ten workflows per minute and one
per second; each user has a ten-second cooldown. Event IDs are retained for one
minute. State is process-local and bounded to 10,000 admitted events.
Rejected events do no REST work (interactions may expire). These conservative
limits apply to commands, buttons and message catches together, including their
sticky refresh, and do not establish measured hosting capacity.

Buttons must belong to the current configured sticky message. User/role exemptions
are checked before message deletion; unavailable role evidence fails closed.
Raw REST requests have ten-second abort deadlines. Unban retries stop on permission
failure and never shorten a server delay to fit the five-second waiting budget.

Remaining readiness gaps: shared raw/discord.js route and global scheduling,
fair queued admission, ban 429 retries, jittered transient retries, durable delayed
unban recovery (error/recovery lane), and cross-process deduplication. Long unban
delays currently report staff recovery required; they are not persisted. This draft
does not close the entire public-readiness rate-limit section.

Validation: regression tests added for guild isolation, deduplication, cooldowns
and caps. npm test could not compile: tsc is not installed. No dependencies installed.
