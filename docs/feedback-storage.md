# Feedback storage: SQLite and PostgreSQL

SQLite remains the default. The backend is selected per BotMux data directory, shared by all its bots, CLI sends and Dashboard analytics. Session and scheduler databases are unaffected.

## PostgreSQL compatibility

PostgreSQL 17 is supported. Storage, TLS certificate validation, concurrent feedback, analytics, SQLite migration and crash recovery have been exercised against PostgreSQL 17.11 with Node and Bun. These checks required no PostgreSQL-specific runtime SQL changes.

CI runs the same integration suite against PostgreSQL 15 and 17. Set `BOTMUX_TEST_POSTGRES_MAJOR=17` when verifying a PostgreSQL 17 endpoint; the test checks the server's actual `server_version_num` so accidentally connecting to another major version fails validation.

The backend version selection is independent of production credentials and schema permissions. Compatibility testing does not upgrade or migrate an existing production database.

## Configure

On a new interactive `botmux start`, select SQLite or PostgreSQL. Existing installations continue without a prompt. PostgreSQL accepts a JSON configuration file containing a credential reference:

### Username and password

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

### BytePG compute ID and token

For a gateway accepting `options=bytepg_compute_id=... bytepg_auth_token=...`, use structured authentication rather than putting a complete credential-bearing URL in `host`:

```json
{
  "backend": "postgresql",
  "postgres": {
    "host": "2001:db8::1",
    "port": 4432,
    "database": "aidb",
    "schema": "botmux_feedback",
    "bytepg": {
      "computeId": "cp-example",
      "tokenRef": "env:BOTMUX_BYTEPG_TOKEN"
    },
    "tls": { "mode": "verify-full" },
    "connectTimeoutMs": 5000
  }
}
```

Replace the example address/compute ID with your endpoint. An IPv6 `host` is the address without URI brackets. The client sends `bytepg_compute_id` and `bytepg_auth_token` in PostgreSQL startup `options`, together with BotMux's schema `search_path`; do not URL-encode the token stored in the referenced environment variable.

BytePG mode does not require `passwordRef`. `user` is optional: when omitted, BotMux resolves `PGUSER`, `USER`, `USERNAME`, then the operating-system account; it fails before connecting if none can supply an identity. Specify `user` if the gateway requires a particular role. Do not configure both password and BytePG token authentication. The gateway must accept the startup options and the role must retain the schema privileges described above.

Dashboard provides **Authentication → BytePG token**, Compute ID and a write-only token field. Leave the token blank to preserve its reference. CLI configuration accepts `tokenRef`; `--token` and `--password` credential arguments are rejected. Regular configuration, API views, migration metadata and recovery records contain only references, not token values.

TLS defaults to certificate verification. Set a trusted CA when required; never disable verification to hide a certificate failure. BytePG server errors/notices are deliberately reported as generic errors because gateways may echo startup options containing the token. Token expiry does not fall back to password authentication or SQLite. Static references are loaded when pools are created; restart affected processes after rotating those references.

### Dynamic doas credentials

Instead of `tokenRef`, configure a structured doas source:

```json
"bytepg": {
  "computeId": "cp-example",
  "doas": {
    "psm": "data.example.service",
    "environment": "boe"
  }
}
```

The host must have `doas`, Perl with the standard Fcntl/POSIX modules, and noninteractive authorization for the selected PSM/environment. BotMux executes fixed arguments equivalent to `doas --type gdpr -p <psm> --print-env -e <environment> --no-interaction`, with an explicit private identity directory. It accepts a single bare token line, never evaluates shell output, and does not expose stdout/stderr.

Both acquisition and `doas clean` use the same 0700 cache root under `<dataDir>/feedback-doas/<source-hash>`, with `TMPDIR`, `TMP`, `TEMP` and `DOAS_IDENTITY_DIR` explicitly scoped. The cross-process refresh lock lives outside the cache entries removed by clean. Shared user doas caches are not copied or cleaned; a fresh private cache may require an administrator to establish noninteractive authentication.

No TTL is assumed and there is no periodic clean. Only a new-connection authentication rejection (`28000` or `28P01`) triggers one serialized clean/refetch and one reconnect. Other callers that rejected the same generation reuse the replacement rather than cleaning again. Network/TLS errors and SQL/transaction errors never trigger this recovery, and SQL is never replayed. The cleanup attempt is recorded before execution, so failed or interrupted cleanup is not blindly repeated. Later connection attempts may retry acquisition; a hash of the rejected credential prevents returning that same token. If doas continues returning it, an administrator must restore authentication in the private cache.

An exclusive `flock` on the command file serializes private-cache operations, and the credential command runs in its own process group with an independent timeout. A later operation therefore never runs concurrently with an in-flight acquisition or clean, including after the calling BotMux process dies mid-command: it proceeds only once the in-flight command finishes or its timeout fires. This command lock is separate from the parent-process metadata lock.

Dashboard provides **Token source → Dynamic doas**, PSM and environment. Token values remain in process memory; BotMux persists only generation metadata and credential hashes (doas itself manages its private credential cache). Acquisition/cleanup commands have time and output bounds. No arbitrary command string can be supplied through this configuration.

Local tests exercise startup-packet encoding (including IPv6), escaping, error/notice redaction and existing PostgreSQL 17 storage/migration behavior. They do not certify authorization against a production BytePG gateway; use **Test saved connection** in an authorized environment before migration, without sharing tokens in chat or logs.

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

### Cancel or resolve an interrupted migration

Use the original task ID, not manual deletion of migration files:

```bash
botmux feedback storage cancel MIGRATION_ID --yes \
  --reason "Incorrect candidate configuration" --evidence "ticket:reviewed-original-operation"
```

- Before freezing: cancellation releases maintenance, including an interrupted draining stage without a guard table.
- After freezing but before retirement: cancellation restores SQLite writes and invalidates the old snapshot identity.
- After retirement or PostgreSQL activation: cancellation is refused. Resume the original migration or recover PostgreSQL; never switch to the stale SQLite source.
- A cancelled task remains in history and cannot resume its import. Configure a corrected candidate and start a new request ID. PostgreSQL data and snapshots are retained; if the old task already created its target schema, use a new empty schema or perform a separately reviewed database cleanup. Cancellation never drops target data.
- An active runner owns a cross-process lock. Concurrent recovery returns `feedback_migration_busy_retry`; wait for the current operation or retry after its process has exited. It does not clear a live lock.

Unknown webhooks and dead `botmux send` leases require an explicit outcome decision:

```bash
botmux feedback storage recovery list
botmux feedback storage recovery acknowledge --kind webhook --id OUTBOX_ID \
  --fingerprint FINGERPRINT --yes --reason "Destination receipt checked" \
  --evidence "ticket:receipt-and-idempotency-key"
```

Use `--kind send` with the exact lease filename for a dead send process. Before acknowledging, verify the destination event/idempotency key or original send receipts and record the evidence reference. The service rejects live processes, in-flight webhooks and stale fingerprints. Acknowledgement retains the original marker/lease and records an audit entry; it neither sends anything nor clears unrelated items. New attempts or changed outcomes invalidate the old fingerprint.

The same operations are available under **Feedback storage → Manual recovery and resolution** in Dashboard. Host administrator and CSRF checks apply. Confirmation, reason and external evidence are mandatory; do not place credentials in audit text.

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
- Plan PostgreSQL `max_connections` for every daemon plus Dashboard/CLI connection pools. Each pool is capped at five connections, but this is a per-process limit, not a fleet-wide limit.

## Development verification

Use only disposable databases and data directories:

```bash
bun run test -- test/feedback-storage-config.test.ts test/feedback-storage-api.test.ts test/feedback-storage-cli.test.ts test/feedback-storage-panel.test.ts test/feedback-maintenance.test.ts
bun run test:e2e -- test/feedback-postgres.e2e.ts test/feedback-migration.e2e.ts
bun run build
bun run build:bun
```

Integration tests require `BOTMUX_TEST_POSTGRES_URL` for an isolated PostgreSQL database and `BOTMUX_TEST_POSTGRES_CA` for its test TLS CA. Only unique test schemas are created/deleted. Use an isolated HOME for migration tests so unrelated fleet state is not interpreted as participants.
