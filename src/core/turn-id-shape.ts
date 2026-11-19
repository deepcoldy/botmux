/**
 * Shape validation for the identity turn id carried in the CLI PID marker.
 *
 * The marker is JSON written in the worker (the wrapper is /bin/sh and must not
 * spawn jq), but the file lives where the CLI can rewrite it, so every
 * identityTurnId read back from it is re-validated before use:
 *
 *  - must be a non-empty STRING (numbers, objects, null fall back to the
 *    envelope turn rather than being stringified into an authority tuple);
 *  - at most 256 chars (the marker is a single bounded JSON record);
 *  - no ASCII control chars (0x00–0x20) or DEL (0x7f): no embedded newlines,
 *    tabs, NULs or whitespace-only values that could smuggle a second record
 *    past a line-oriented reader.
 *
 * The envelope turn fallback is the caller's job (see markerIdentityTurnId in
 * worker.ts); this predicate only decides shape.
 */
export function isValidMarkerIdentityTurnId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\x00-\x20\x7f]/.test(value);
}
