/**
 * What providers write when a model call fails — the reason the failure panel
 * exists to show, in the provider's own words. None holds a credential, so
 * every masking and clipping step on the way to the page must leave each one
 * exactly as written (the 403's "Access denied" and its model name above all).
 */
export const PROVIDER_ERROR_TEXTS: ReadonlyArray<readonly [name: string, text: string]> = [
  ['Claude 403', 'API Error: 403 {"type":"error","error":{"type":"permission_error","message":"Access denied for model model_hub/es1_orange_o50"}}'],
  ['Claude 429', 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization of 50,000 input tokens per minute. Please reduce the prompt length or the maximum tokens requested, or try again later."},"request_id":"req_011CUz9mXyZ8kQ"}'],
  ['Claude 429, retrying', 'API Error (429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}) · Retrying in 1 seconds… (attempt 1/10)'],
  ['Claude 529', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CV1a2b3c4"}'],
  ['Claude 401', 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."}}'],
  ['connection reset', 'API Error: Connection error. (ECONNRESET)'],
  ['read ECONNRESET', 'Error: read ECONNRESET\n    at TLSWrap.onStreamRead (node:internal/stream_base_commons:218:20)'],
  ['socket hang up', 'Error: socket hang up\n    at TLSSocket.socketOnEnd (node:_http_client:524:23)'],
  ['Codex, rate limited', 'stream disconnected before completion: exceeded retry limit, last status: 429 Too Many Requests, request id: req_abc123'],
  ['Codex, unauthorized', 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header'],
  ['Codex, invalid request', '-4003 invalid_request_error: input[0].tools[0].description: string too long. Expected a string with maximum length 1024'],
  ['Codex, upstream', 'upstream stream error: rpc error: code = 1 desc = Cancelled by backend [biz error]'],
  ['Codex, no reply', 'unexpected status 527: empty provider response'],
];
