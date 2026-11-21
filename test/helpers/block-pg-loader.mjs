// ESM resolve hook that makes the optional `pg` dependency unresolvable.
// Used to prove the daemon/send module-load graph works with a SQLite-only
// install (node_modules present but `pg` missing).
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'pg' || specifier.startsWith('pg/')) {
    const error = new Error(`Cannot find package '${specifier}' (blocked by test loader)`);
    error.code = 'ERR_MODULE_NOT_FOUND';
    throw error;
  }
  return nextResolve(specifier, context);
}
