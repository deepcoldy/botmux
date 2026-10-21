# Dispatch report delivery

For locally registered dispatches, `botmux report --dispatch-root <om_seed>` supports three delivery modes:

| `--delivery` | Visible result | Source session |
| --- | --- | --- |
| `relay` (default) | Existing behavior | Receives the report |
| `publish` | Markdown card in the dispatch thread | Not triggered |
| `publish-and-relay` | Markdown card in the dispatch thread | Receives the report and published message ID |

Use `--publish-to chat` to publish at the top level of the current task group. The daemon derives that group from the authenticated session. Publication requires an explicit dispatch root and a valid signed dispatch binding; `--into`, `--top-level`, and `--legacy-dispatch` cannot be combined with it. Private-card and API-only sessions cannot publish reports.

```sh
botmux report --dispatch-root om_seed --delivery publish --content-file result.md
botmux report --dispatch-root om_seed --delivery publish-and-relay --publish-to chat --content-file result.md
```

`botmux dispatch --bot-app <app_id> --result-delivery <mode> ...` puts the matching report command in the task instructions. The target must use default prompt injection. Zero-prompt sessions retain their automatic final-answer relay and reject explicit publication modes; standby and legacy/external bot dispatches do not support this option. The daemon also checks the live session's frozen prompt mode, so changing bot configuration does not bypass this boundary.

Status is independent of delivery. Pass `--status completed --progress 100` only when the task is actually complete; sending a report does not infer completion.

## Receipts and retries

Publication returns `publishedMessageId` and `publicationTarget`. Combined delivery also returns the source session receipt. If publication succeeds but relay fails, the error includes the published message ID and `deliveryKey`; retry the same command in the same active turn to retry only relay. The daemon journals publication and completion under `report-deliveries/` and serializes concurrent retries. A successful receipt can be replayed after a daemon restart if the same turn is still authorized.

Before sending, the daemon measures the rendered card in both create and thread-reply request envelopes. Requests over 30,000 bytes return `413 report_publication_too_large` with `requestBytes` and `maxBytes`, without creating a publication journal. Shorten the report and retry; Markdown tables and escaped content can make the request larger than the source text.

An explicit provider rejection (HTTP 4xx other than 408, or a recognized invalid-input, membership, withdrawn-message or sensitive-content error) returns `422 report_publication_rejected` and clears the pending entry. Correct the cause and retry the same operation. Content is part of the delivery key: changed content is a new publication, while identical content in the same turn reuses the existing receipt.

If the provider response is lost or the daemon crashes during publication, `report_publication_unknown` stops automatic retries. Check the original conversation before taking further action. This version has no automatic reconciliation command; keep the journal for diagnosis and do not delete it or change the content/placement to force a repost. A later task turn is a separate operation and requires its own authorization.

Publication uses the normal outbound hook and ownership path. Provider calls in the tests are substitutes; real Feishu rendering and transport need deployment verification.
