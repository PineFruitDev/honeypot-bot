# Guild storage operations

Run exactly one bot process against a persistent DATA_DIR. File storage is not a multi-process or shard database; enforce one replica in the host supervisor. Store mutations are serialized, but Discord setup/remove workflows are not transactional across remote API calls.

The version 1 guilds.json format retains the existing guild-ID map and totals. Unversioned keyed files load with kick and empty-history defaults; the next mutation writes version 1. No global trap format exists in this repository. Unscoped global data is rejected rather than copied to every server: an operator must explicitly map each legacy trap to its owning guild in the guilds object before starting.

Invalid or unreadable files block startup. Writes use a synced temporary file and atomic rename; failed writes reject and roll back memory. The previous file is retained as guilds.json.bak. Backups may retain departed-guild data until the next successful write; external backups require an operator retention policy. Live records and totals are deleted on guild departure or the next ready reconciliation after an offline departure. Unavailable guilds are retained.

Restore drill (bot stopped): preserve the failed primary for diagnosis in restricted storage, copy guilds.json.bak to guilds.json, then start one instance. Verify the expected guild/channel mapping and catch totals before enabling traffic. Restore can roll back the most recent mutation and can temporarily restore departed records, which ready reconciliation deletes. Never restore an older backup while a writer is running. Keep both files on the same persistent filesystem. Power-loss durability of the directory entry depends on the filesystem; atomic rename does not provide distributed transactions.

Regression tests cover restart, migration/defaults, isolation, concurrent store mutations, corrupt input and failed disk writes. This checkout has no installed dependencies; tests were added but not executed. Full remote setup/remove serialization and replica support remain follow-up work.
