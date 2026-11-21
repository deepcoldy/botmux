/** Canonical Riff upload placeholder contract.
 *
 * The Riff client rewrites local file arguments to `riff-upload:<index>` only
 * after its own preflight. The host accepts that exact form and resolves it
 * against the request's upload manifest. Keeping the regex in one module keeps
 * the client's "reject hand-written placeholders" check and the host's strict
 * structural check from drifting apart. */

export const RIFF_UPLOAD_PREFIX = 'riff-upload:';

const HOST_UPLOAD_PLACEHOLDER = /^riff-upload:(0|[1-9]\d*)$/;
const CLIENT_UPLOAD_PLACEHOLDER = /^riff-upload:/i;

/** Strict host form: lowercase, decimal, no leading zero. */
export function parseRiffUploadIndex(value: string): number | undefined {
  const match = HOST_UPLOAD_PLACEHOLDER.exec(value);
  if (!match) return undefined;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) ? index : undefined;
}

/** Client mode deliberately trims and ignores case: a model or user must not
 *  be able to smuggle a hand-written placeholder through a spelling variant. */
export function isRiffUploadPlaceholder(value: string, mode: 'client-loose' | 'host-strict'): boolean {
  return mode === 'host-strict'
    ? HOST_UPLOAD_PLACEHOLDER.test(value)
    : CLIENT_UPLOAD_PLACEHOLDER.test(value.trim());
}
