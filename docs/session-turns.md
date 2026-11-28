# Structured session turns

`GET /api/sessions/:sessionId/turns?since=&limit=50` uses the local Dashboard
administrator token. A successful response contains `ok`, `schema`
(`botmux.session-turns.v1`), `capabilities`, `next`, and `turns`.

- Omit `since` for the first page, then pass the returned `next` verbatim.
  The page size defaults to 50 and accepts 1–100.
- Each result is a snapshot for one `turnId`, sorted by its latest update `seq`.
  Replace the previous snapshot for that `turnId`. A reply can make a turn
  appear again in a later page. An empty page preserves the cursor.
- `inbound` contains source message text and display metadata. The API does not
  include attachment paths, resource keys, or generated download URLs. Text
  uses the existing insight secret scrubber and omits recognizable local paths.
- `anchor.inputSha256` hashes the UTF-8 CLI input. Native session and entry IDs
  are included when observed. Prompt envelopes and credentials injected by
  the host are not returned.
- `replies` includes the provider message ID, response kind, and send timestamp.
  `text` is optional. Standard Markdown replies reuse text already held by the
  send command. Custom cards and attachment bodies have no text guarantee.
- Records survive process restarts. Closing a session deletes its records.
  Turns from before this feature was installed are not reconstructed.

## Continue a session as its owner

Check the target session's `capabilities` for `ownerActor` before sending an
owner request. On older versions, proceed with the ordinary external event
path. A missing `actor` in the response is not a reason to resend.

Send `POST /api/trigger` with the local Dashboard administrator token and
the following JSON body.

```json
{
  "source": { "type": "webhook", "connectorId": "example-client" },
  "target": { "kind": "turn", "botId": "<bot id>", "sessionId": "<session id>" },
  "actor": "owner",
  "instruction": "Continue the tests",
  "envelope": { "format": "text", "sourceName": "Example client", "trusted": false }
}
```

The server resolves the bot owner against the bot's current allowlist:

- An explicit `ownerOpenId` or `ownerUnionId` in `bots.json` names the owner
  while it is still in the resolved allowlist. `ownerUnionId` must also be an
  `allowedUsers` entry. When both are set, they must name the same person.
- Without an explicit owner, an allowlist whose entries all resolve to one
  person makes that person the owner.
- Otherwise the request returns 403 `owner_unresolved`. With several people
  and no explicit owner, the server does not pick one.

Check `capabilities` for `ownerUnionId` before adding the optional top-level
`actorUnionId` (the caller's `on_…` union_id). With it, the request succeeds
only when that person is the resolved owner, and returns 403
`owner_mismatch` for anyone else. When the owner is not listed by union_id,
the bot looks up the owner's union_id. If that lookup fails, the request
returns `owner_unresolved`. `actorUnionId` without `"actor": "owner"`, or
not shaped as a union_id, returns HTTP 400. Versions without the capability
ignore `actorUnionId` and act as the owner anyway, so probe first. A current
Dashboard in front of an older bot returns 503 `daemon_upgrade_required`
instead.
The instruction enters the existing session as a follow-up. Successful
responses echo `"actor": "owner"`, and the session records the input as
`via: "owner_actor"`. Topic presentation follows the existing policy.

Other actor values and requests carrying `envelope.payload` or
`envelope.rawText` return HTTP 400. Webhook authentication, public-read tokens,
and H5 or platform identities cannot submit an actor and receive
`actor_not_allowed`.

Owner attribution alone does not publish personal CLI credentials. For a bot
that uses trigger-user authentication, set `triggerUserAuth.allowOwnerActor`
to `true` to opt into that bot's configured per-user credential policy.
The one exception is `lark-cli --as user` in a bound session of a bot whose
trigger-user authentication does not cover lark-cli: under
`larkUserOwnerFallback` (default on) it uses the owner's own grant to the bot
application, like any other turn nobody started. See
[lark-tool-identity.md](lark-tool-identity.md).
