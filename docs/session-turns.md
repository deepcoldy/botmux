# Structured session turns

`GET /api/sessions/:sessionId/turns?since=&limit=50` uses the local Dashboard
administrator token. A successful response contains `ok`, `schema`
(`botmux.session-turns.v1`), `capabilities`, `next`, and `turns`. The capabilities
array is empty in this version.

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
