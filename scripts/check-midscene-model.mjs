#!/usr/bin/env node
// CI preflight: fail fast when the Midscene vision model is unreachable, before
// a suite spends minutes on browser setup. Shared by the Dashboard and Feishu
// jobs in .github/workflows/midscene-e2e.yml.
const baseUrl = process.env.MIDSCENE_MODEL_BASE_URL?.replace(/\/+$/, '');
if (!baseUrl || !process.env.MIDSCENE_MODEL_API_KEY || !process.env.MIDSCENE_MODEL_NAME) {
  throw new Error('MIDSCENE_MODEL_BASE_URL, MIDSCENE_MODEL_API_KEY and MIDSCENE_MODEL_NAME are required');
}
const response = await fetch(`${baseUrl}/chat/completions`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.MIDSCENE_MODEL_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: process.env.MIDSCENE_MODEL_NAME,
    messages: [{ role: 'user', content: 'Reply OK.' }],
    max_tokens: 1,
  }),
  signal: AbortSignal.timeout(90_000),
});
if (!response.ok) {
  throw new Error(`Model preflight returned HTTP ${response.status}`);
}
await response.arrayBuffer();
