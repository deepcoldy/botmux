/** Human-readable message of a thrown value: an Error's `message`, else
 *  `String(value)`. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
