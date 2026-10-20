# Turn Results

`TurnResult` separates native execution, final output, and acknowledged delivery. Reading a result does not run a model, send a message, or authorize a business action.

## Opt-in and Authorization

Enable the feature in the selected bot configuration:

```json
{ "turnResults": { "enabled": true } }
```

It is off by default. Configuration uses the existing bot-loading lifecycle. Subsequent collection or reads clear cached content after enablement is withdrawn.

The JSON endpoint requires existing trusted-host HMAC authentication. It is not a core-only public route and does not grant access based on a session capability or knowledge of a result reference. The serving daemon selects the bot identity.

```text
GET /api/sessions/:sessionId/turns/:turnId/result
GET /api/sessions/:sessionId/turns/:turnId/result?dispatchAttempt=1
```

Use existing daemon discovery and trusted-host request signing. An omitted attempt matches an actual absent attempt; it never selects the latest attempt.

Lookup HTTP 200 does not imply execution or delivery success. Invalid references return HTTP 400, missing authentication returns 401, and a non-host handler request returns 403.

| Lookup status | Meaning |
|---|---|
| `ready` | Includes a `result` with independently established execution and output/delivery facts |
| `not_ready` | Insufficient facts to establish a complete result |
| `unavailable` | Disabled, unsupported, or expired evidence; no guessed output |
| `not_found` | No exact reference remains; no historical recovery is attempted |

## Result Contract

The versioned object includes:

- `ref`: bot, session, turn, and optional dispatch attempt.
- `source`: verified input channel and original conversation/message.
- `execution`: `completed`, `failed`, `cancelled`, or `ambiguous`. Unmeasured timing is omitted.
- `output`: `available`, `empty`, or `unavailable`, with authoritative final content when permitted. An explicit final takes precedence over different later transcript text.
- `deliveries`: destination, delivery status, and acknowledged `primary`/`attachment` message IDs.

Delivery may be `delivered`, `partial`, `failed`, `unknown`, or `suppressed`. An existing card ID does not prove a final PATCH succeeded. Long answers may have a separate Markdown attachment; only acknowledged final carriers are returned.

Native completion is not delivery success. Content rejected by platform audit is not exposed to bypass that audit. Failed execution does not expose partial model text. Oversized result content returns `output.status=unavailable` with `reason=result_too_large`, not a truncated answer.

## Coverage and Retention

The first version supports ordinary IM transcript finals with trusted inbound provenance and acknowledged publication in the current generation. Cross-process explicit finals, reused cards, and shapes without complete publication provenance remain unavailable/not ready. The feature does not infer content, generation, or all attachments from send markers, old card records, the latest message, or historical transcripts.

Raw passthrough input (direct native CLI commands) sent to an existing session does not record a trusted `sourceMessageId`, so those turns are not collected. Initial cold-start passthrough can carry the actual inbound message provenance and remains subject to the same mode, ownership, and publication checks. Reply targets are not used to invent inbound provenance.

Meeting receivers, document comments, private replies, sandbox/read isolation, silent schedules, adopted sessions, and headless/HTTP turns are not generic content-export paths. Existing trigger, headless, and workflow APIs remain unchanged.

An unsupported session or turn withdraws only its exact result reference, leaving other sessions and attempts of the same bot intact. Disabling the feature or withdrawing bot-level policy still clears that bot's results.

The daemon keeps only bounded in-memory snapshots:

- 128 pending/ready contexts and 16 MiB total.
- 1 MiB maximum per result.
- 15 minutes for ready snapshots and 5 minutes for pending evidence.
- Lazy expiry; reads do not extend retention; no persistence across restart.

This is not a side-effect deduplication ledger or recovery system. It does not guarantee automatic redelivery or exactly-once consumption. Existing completion webhooks and feedback storage remain content-free.

## Internal Observer

An embedding host may supply the optional worker-pool `onTurnResult(result)` observer. It receives the same immutable result after facts converge. No consumer is configured by default and no external command is executed.

Observer errors and the 10-second observation deadline do not resend the source answer or retry the model. The deadline does not cancel arbitrary observer work or prove no business action occurred. Reading or observing a result does not grant additional write authority.
