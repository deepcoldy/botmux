# TraeX per-Bot backend variant design

## Goal

Let a Botmux bot using TraeX explicitly choose the TraeX backend variant for
new sessions. The Dashboard exposes inherit, Standard, and Max alongside the
existing model and reasoning-effort controls.

This resolves the current gap where `model_backend_variant = "max"` can be
configured in TraeX's user-global configuration but cannot be inspected or
overridden per Botmux bot.

## Contract and compatibility

The persisted Bot config and Dashboard agent API use one optional field:

~~~ts
type ModelBackendVariant = 'standard' | 'max';

modelBackendVariant?: ModelBackendVariant;
~~~

- The field is valid only when `cliId === 'traex'`. A bot using another CLI
  never persists or launches with it.
- Its absence means **inherit TraeX's global configuration**. Botmux sends no
  `model_backend_variant` override in this case. This preserves every existing
  bot's behavior, including installations that already set a user-global Max
  variant.
- An explicit `standard` or `max` is passed to a new TraeX process as
  `-c model_backend_variant=...`; it overrides the user-global setting only
  for that process.
- Botmux does not maintain a per-model variant catalog. TraeX remains the
  authority for whether an explicitly selected backend variant is valid for
  the selected model and account.
- A malformed API value receives HTTP 400. When an agent save switches away
  from TraeX, any stored value is deleted atomically with the CLI change.
- Existing sessions are not changed. A new session freezes its selected
  variant so a later Bot configuration change cannot alter resume or respawn
  behavior.

## Data flow

1. `bots.json` parsing normalizes `modelBackendVariant` only for TraeX bots.
   Invalid values and values on every other CLI are discarded.
2. The private Bot Defaults DTO exposes the optional field. Public dashboard
   data remains unchanged.
3. `PUT /api/bot-agent` accepts `modelBackendVariant`. For TraeX, an omitted
   field preserves the stored value; `""` clears it back to inheritance;
   `standard` and `max` replace it. For other CLI selections the field is
   cleared regardless of body content. The response returns the normalized
   value.
4. The session launch snapshot and daemon-to-worker init payload carry the
   field. A normal TraeX adapter appends exactly one process-local
   `-c model_backend_variant=<JSON-string>` only when the frozen value exists.
   The Codex/TraeX RPC engine writes the same key into a fresh `thread/start`
   configuration, but never sends it on `thread/resume`; TraeX restores the
   persisted thread configuration on resume.
5. Runtime/card state carries the frozen variant. The session card displays it
   between model and reasoning effort, for example `GPT-5.6-Terra · Max ·
   xhigh`. Omitted means there is no extra label, because the inherited value
   is intentionally unknown to Botmux.

## Dashboard behavior

The Agent configuration section displays a `Backend variant` dropdown only
when the selected CLI is TraeX:

| Stored value | Dashboard label | Launch behavior |
|---|---|---|
| absent | Follow TraeX global setting | no config argument |
| `standard` | Standard | `-c model_backend_variant="standard"` |
| `max` | Max | `-c model_backend_variant="max"` |

Switching the CLI away from TraeX resets the local draft to inherit. Switching
back before saving leaves the value inherited unless the user selects a variant
again. The form's save result patches the normalized field into local Dashboard
state, so a page refresh is not required. Chinese and English labels and help
text distinguish backend variant from reasoning effort.

## Error handling and safety

No configuration is written on invalid variant values. Model and reasoning
effort keep their current validation behavior; this feature does not broaden
the existing static reasoning-effort catalog. The only affected agent adapter
is TraeX, so Codex, Grok, and all other CLI launch arguments remain byte-for-
byte unchanged. Existing session serialization treats a missing variant as an
old, valid snapshot and falls back to inheritance only for sessions that were
created before this feature.

## Verification

- Parsing tests prove valid TraeX values survive and non-TraeX/invalid values
  are dropped.
- Adapter and RPC-engine tests prove fresh explicit values add the exact
  configuration key, inherited values add none, and resume requests do not
  restamp it.
- Dashboard IPC tests cover persistence, clear-to-inherit, invalid 400, and
  cleanup on a CLI switch.
- Worker/session tests prove frozen values reach fresh and resumed TraeX
  launches without changing other CLI payloads.
- Dashboard component tests cover TraeX-only rendering, save payloads, local
  state refresh, and English/Chinese copy.
- Targeted tests, TypeScript compilation, and the production build run before
  every commit. A live daemon restart is deferred until the implementation is
  complete and the user is ready to exercise the Dashboard manually.
