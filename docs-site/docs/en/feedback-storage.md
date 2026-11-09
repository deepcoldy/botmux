# Feedback Storage & Migration

botmux keeps "feedback data" in a database: user ratings of final answers, the outcome of each turn, the delivery queue for feedback webhooks, and so on. This is what the Dashboard "Feedback analytics" page shows.

- **SQLite by default**: a local file, `botmux-feedback.sqlite`, in the botmux data directory (`~/.botmux/data/` by default). Nothing to install, and most people never need anything else.
- **PostgreSQL if you want it**: switch when you need central storage, backups, or to plug the data into your own analytics.

You switch storage with the `botmux feedback storage` command or with the "Feedback storage" panel on the Dashboard "Feedback analytics" page. Both can do the same things.

## Which should I pick?

| My situation | What to do |
|---|---|
| Fresh install, no special needs | Press Enter when the first `botmux start` asks about storage to keep SQLite |
| Fresh install, want PostgreSQL right away | Type `postgresql` at the first start, then give the config file path (see [Step 1](#step-1-prepare-a-config-file)) |
| On SQLite, **no feedback data yet** | [Empty database: enable directly](#no-existing-data-enable-directly) |
| On SQLite, **with history to keep** | [Migrate](#step-3-migrate) (needs a short downtime) |
| On PostgreSQL, want SQLite back or a different database | Not supported yet, see the [FAQ](#faq) |

> If the first start does not run in an interactive terminal (for example from a script), botmux uses SQLite without asking.

## Three things to know before migrating

1. **Service pauses during migration**: once the "maintenance window" starts, new topics, new turns, and `botmux send` are refused, and restarted daemons wait, until the migration completes or is cancelled. Pick a quiet time.
2. **No automatic fallback**: after switching to PostgreSQL, botmux will not switch back to SQLite on its own if the database fails. The old SQLite file is kept but marked "retired" and no longer written.
3. **Passwords never go on the command line or in the config file**: only "secret references" are allowed, see [How to supply the password](#how-to-supply-the-password).

## Switch from the command line

### Step 1: Prepare a config file

Create a JSON file, for example `pg.json`:

```json
{
  "backend": "postgresql",
  "postgres": {
    "host": "db.example.com",
    "port": 5432,
    "database": "botmux",
    "user": "botmux",
    "schema": "botmux_feedback",
    "passwordRef": "env:BOTMUX_FEEDBACK_PG_PASSWORD",
    "tls": { "mode": "verify-full" },
    "connectTimeoutMs": 5000
  }
}
```

| Field | Meaning |
|---|---|
| `host` / `port` / `database` / `user` | Connection details, all required |
| `schema` | A schema just for botmux. Pick a name that **does not exist yet** in the database; botmux creates it. Lowercase letters, digits, and underscores, not starting with a digit |
| `passwordRef` | A reference to the password, not the password itself (see below) |
| `tls.mode` | `verify-full`: verify the server certificate (recommended); `disable`: no encryption |
| `tls.caRef` | Optional reference to a custom CA certificate, same format as `passwordRef` |
| `connectTimeoutMs` | Connection timeout, 100–60000 ms |

Extra fields (such as a `password` key) are not allowed and the file will be rejected.

### Step 2: Save it as the candidate and test it

```bash
botmux feedback storage configure --config-file ./pg.json
botmux feedback storage test
botmux feedback storage status
```

- `configure` only saves it as the "candidate" config. **It does not switch and does not touch any data.**
- `test` connects to the database and checks that the account has the `CREATE` privilege on it (botmux needs it to create its own schema and tables).
- `status` shows the active storage (`active`), the candidate (`candidate`), and past migration jobs. Running `botmux feedback storage` with no subcommand also shows `status`.

All commands print JSON. On error they print `{"error":"feedback_..."}` and exit with code 1.

### Step 3: Migrate

```bash
botmux feedback storage migrate --to postgresql --yes
```

`--yes` confirms that you accept the maintenance window; without it the command is refused. The command runs until it finishes and prints something like:

```json
{"migrationId":"5dd49f52-...","phase":"complete","blockers":[]}
```

`phase: complete` means success (exit code 0), and feedback data now goes to PostgreSQL. Along the way it passes through these phases:

| Phase | What happens |
|---|---|
| `preflight` | Connect to the target and prepare the tables |
| `draining` | Enter the maintenance window and wait for running turns to finish (about 45 seconds max) |
| `snapshot` | Take a read-only snapshot of SQLite |
| `importing` | Import the snapshot into PostgreSQL (the target must be empty) |
| `verifying` | Compare row counts and contents table by table |
| `retiring` / `activating` | Retire SQLite and switch to PostgreSQL |
| `complete` | Done, the maintenance window ends |

If `phase` is `blocked`, the migration is stuck. See the next section.

### Stuck: resume or cancel

When `blocked`, `blockers` tells you why. **The maintenance window does not end on its own after a block**, so new turns stay blocked until you pick one:

```bash
# After fixing the problem, continue the same job (safe to repeat)
botmux feedback storage resume <migrationId>

# Give up and restore the original SQLite
botmux feedback storage cancel <migrationId> --yes \
  --reason "Target lacks permissions, retry later" \
  --evidence "ticket:1234"
```

- `cancel` needs `--yes`, `--reason` (why you cancel), and `--evidence` (what you checked, such as a ticket number). They are kept in an audit record.
- Cancelling only restores SQLite. **Data already written to PostgreSQL is not deleted.**
- Once SQLite has been marked retired (after the `retiring` phase finishes), you cannot cancel. Use `resume` to finish.

Common `blockers`:

| Reason | What to do |
|---|---|
| `feedback_maintenance_not_ready` | Not ready within 45 seconds: turns are still running, a `botmux send` is in progress or has an unknown outcome, or a daemon did not respond. Wait for turns to finish; acknowledge unknown sends via [Delivery recovery items](#delivery-recovery-items), then `resume` |
| `feedback_outbox_unsettled` | There are webhook deliveries with unknown outcomes. See [Delivery recovery items](#delivery-recovery-items), then `resume` |
| `feedback_storage_target_not_empty` / `feedback_migration_target_not_empty` | The target schema already exists and was not created by botmux, or it already holds feedback data. Use a schema name that does not exist yet |
| `feedback_storage_secret_missing` | The password reference cannot be read (env var not set or file missing) |
| `feedback_migration_database_or_io_error` | A database or disk error, most often the database is unreachable or permissions are missing. Run `test` to narrow it down, fix it, then `resume` |

### No existing data: enable directly

If SQLite has no feedback data yet, you can skip the migration:

```bash
botmux feedback storage configure --config-file ./pg.json
botmux feedback storage enable-empty --yes
```

If SQLite holds even one row, `enable-empty` refuses (`feedback_storage_migration_required`). Use `migrate` instead.

## How to supply the password

To keep passwords out of shell history and config files, the command line **rejects** `--password` and `--token`, and the config file only accepts references:

| Form | Meaning |
|---|---|
| `env:NAME` | Read from an environment variable, such as `env:BOTMUX_FEEDBACK_PG_PASSWORD` |
| `file:<id>` | Read a protected secret file in the botmux data directory. Created automatically when you enter a password in the Dashboard; you rarely write it by hand |

With `env:`, the variable must exist **both** in the terminal where you run `botmux feedback storage` and in the environment of the botmux service itself, or the service cannot read the password after the switch. The simpler route is to type the password into the Dashboard panel: it is saved as a file readable only by the local user, the config keeps just a reference, and the page never shows it again.

## Switch from the Dashboard

Open the Dashboard "Feedback analytics" page and expand "Feedback storage". Only host admins can see this panel.

> The screenshot is from an earlier version. The current panel also has an "Authentication" dropdown next to "Backend".

<img src="/img/feedback-storage-panel.png" alt="Feedback storage panel: backend set to PostgreSQL, with host, port, database, user, schema, password and TLS fields, followed by save candidate, test saved connection, the maintenance confirmation checkbox and migration buttons" />

1. Set "Backend" to PostgreSQL and "Authentication" to "Username / password", then fill in the connection details. Leaving the password blank keeps the previously saved one.
2. Click "Save candidate settings", then "Test saved connection". The panel shows "Active: sqlite; Candidate: postgresql".
3. Tick "Confirm maintenance", then:
   - with history: click "Migrate and enable PostgreSQL";
   - with no data: click "Empty database: enable directly".
4. The migration runs in the background. The panel refreshes every few seconds and shows `<migration ID>: <phase> <reasons>` at the bottom. Settings are locked while it runs.
5. When it is `blocked`, a "Resume original migration" button appears (the confirmation box must be ticked). It does the same as `resume`.

To cancel, expand "Manual recovery and resolution" below, fill in "Reason" and "External verification evidence", keep the confirmation box above ticked, and click "Cancel migration and restore source". The button only appears while a migration is unfinished.

<img src="/img/feedback-storage-recovery.png" alt="Manual recovery and resolution section: reason and external verification evidence inputs, with buttons to cancel the migration and to list unknown deliveries and send leases" />

## Delivery recovery items

Before migrating, botmux must be sure nothing was "sent with an unknown result", or the data might not line up. There are two kinds:

| Kind | What it is |
|---|---|
| `webhook` | A delivery of a feedback webhook (`feedbackWebhooks` in the bot config) that went out without a clear result |
| `send` | A `botmux send` run whose process exited midway, so it is unknown whether the message went out |

List them:

```bash
botmux feedback storage recovery list
```

First check on the other side whether it actually arrived (for example the webhook receiver's logs, or whether the message is in the Feishu chat), then record your conclusion:

```bash
botmux feedback storage recovery acknowledge \
  --kind webhook --id <id> --fingerprint <fingerprint> --yes \
  --reason "Receiver logs show the event" --evidence "ticket:1234"
```

- Copy `--id` and `--fingerprint` from the `recovery list` output. If the item changed in the meantime you get `feedback_recovery_stale`; just list again.
- Items still in progress (`live: true`) cannot be acknowledged. Wait for them to end.
- Acknowledging only records your decision. It **does not resend** and does not end the maintenance window. Run `resume` afterwards.

On the Dashboard, the "List unknown deliveries and send leases" button in "Manual recovery and resolution" does the same thing, with an "Acknowledge verified outcome" button under each item (it also needs the confirmation box ticked and a reason and evidence filled in).

## Scripted installs

For automated deployments, set the environment variable `BOTMUX_FEEDBACK_CONFIG_FILE` to the config file from Step 1. `botmux start` then saves that config and enables it directly as an empty database (same as `enable-empty`), without asking. If the config matches the active one, nothing happens.

This is only for fresh installs: if SQLite already has data, it fails with `feedback_storage_migration_required`. [Migrate](#step-3-migrate) instead.

## FAQ

**Can I go from PostgreSQL back to SQLite, or to another PostgreSQL?**
Not yet. Migration only supports SQLite → PostgreSQL.

**How long is the downtime?**
It depends on the data size: running turns must finish, then the data is imported and verified table by table. With modest data it is usually quick. Do it off-peak.

**Is the old SQLite file still there afterwards?**
Yes. `botmux-feedback.sqlite` stays in the data directory, retired and no longer written.

**Getting `feedback_storage_generation_conflict`?**
The config was changed elsewhere while you were working (for example in an open Dashboard). Run `status` again and retry. You also get it if you run `enable-empty` without saving a candidate with `configure` first.

**Related pages**: [Bot config (bots.json)](/en/bots-json) covers the final-answer feedback card; [Dashboard](/en/dashboard) introduces the "Feedback analytics" page; other commands are in [CLI commands](/en/cli-commands).
