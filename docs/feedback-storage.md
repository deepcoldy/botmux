# Feedback storage: SQLite and PostgreSQL

SQLite remains the default. The backend is selected per BotMux data directory, shared by all its bots, CLI sends and Dashboard analytics. Session and scheduler databases are unaffected.

## Configure

On a new interactive `botmux start`, select SQLite or PostgreSQL. Existing installations continue without a prompt. PostgreSQL accepts a JSON configuration file containing a credential reference:

```json
{
  "backend": "postgresql",
  "postgres": {
    "host": "localhost",
    "port": 5432,
    "database": "botmux",
    "user": "botmux",
    "schema": "botmux_feedback",
    "passwordRef": "env:BOTMUX_FEEDBACK_PASSWORD",
    "tls": { "mode": "verify-full" },
    "connectTimeoutMs": 5000
  }
}
```

Provision the password environment variable securely to all BotMux processes; never put passwords in command arguments. The role needs database CREATE permission to initialize the dedicated schema and access to its tables afterward. Independent data directories must not share a schema.

```bash
botmux feedback storage configure --config-file /secure/feedback.json
botmux feedback storage test
botmux feedback storage status
```

Candidate settings do not change the active backend. `BOTMUX_FEEDBACK_CONFIG_FILE=/secure/feedback.json botmux start` supports noninteractive initial configuration. An identical active configuration is not reapplied on restart.

For a verified empty installation, run `botmux feedback storage enable-empty --yes`. Existing rows require migration. Empty initialization uses the same fenced cutover machinery.

## Migrate existing feedback

Upgrade every process sharing the data directory first. Schedule a maintenance window: new turns and sends are paused, existing work and persistence must finish, and unknown webhook/send outcomes prevent migration.

```bash
botmux feedback storage migrate --to postgresql --yes --request-id migration-2026-11
botmux feedback storage status
botmux feedback storage resume MIGRATION_ID
```

Reuse the original migration ID after interruption. A nonzero exit or `blocked` status does not prove a transaction rolled back; resume inspects the original target marker.

Migration freezes the source, creates a WAL-consistent snapshot, imports all nine feedback-related tables, preserves IDs and revision ordering, checks row contents and relationships, then switches shared configuration. Original SQLite data and snapshots remain available; the retired source rejects writes.

Do not remove migration files or guards to bypass a blocker. PostgreSQL is never automatically replaced with the old SQLite database: once new feedback arrives, that would hide new records. Reverse migration and merging independent installations are unsupported.

Restoring a pre-activation source invalidates that migration's snapshot identity. Its old job cannot subsequently retire the source or reuse the snapshot after new SQLite writes. Unknown webhook attempt outcomes remain migration blockers even when a retry is no longer in flight.

## Dashboard

Open **Feedback → Feedback storage**. The panel separates active and candidate backends and provides connection testing, migration, empty initialization and recovery. Host administrator authentication is required; writes also require the Dashboard CSRF token.

Passwords are write-only. Leave blank to preserve an existing credential. Dashboard credentials use restricted local files; this feature does not encrypt them. Use TLS certificate verification and configure a custom CA if necessary. Disabling TLS is explicitly unencrypted, not a certificate-error workaround.

## Operational boundaries

- Control remains available during maintenance; user tasks are not forcibly terminated.
- PostgreSQL errors are surfaced, never silently redirected to SQLite.
- Source and target do not share an atomic transaction; retained migration state reconciles cutover.
- Completed webhooks are not replayed. Unknown HTTP results are not exactly-once delivery guarantees.
- External reports directly opening `botmux-feedback.sqlite` need adaptation before cutover.
- Duration depends on active work and data size; no fixed downtime is promised.
- This feature does not install a production database or deploy itself.

## Development verification

Use only disposable databases and data directories:

```bash
bun run test -- test/feedback-storage-config.test.ts test/feedback-storage-api.test.ts test/feedback-storage-cli.test.ts test/feedback-storage-panel.test.ts test/feedback-maintenance.test.ts
bun run test:e2e -- test/feedback-postgres.e2e.ts test/feedback-migration.e2e.ts
bun run build
bun run build:bun
```

Integration tests require `BOTMUX_TEST_POSTGRES_URL` for an isolated PostgreSQL database and `BOTMUX_TEST_POSTGRES_CA` for its test TLS CA. Only unique test schemas are created/deleted. Use an isolated HOME for migration tests so unrelated fleet state is not interpreted as participants.
