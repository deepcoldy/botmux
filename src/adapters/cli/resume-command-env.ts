const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Apply an adapter-allowlisted, non-secret environment AFTER the resume command's
 * executable/wrapper decoration. Keeping these assignments separate from
 * buildResumeCommand prevents an `ENV=value` prefix from being mistaken for the
 * executable by existing command rewriters. */
export function withResumeCommandEnv(
  command: string,
  env: Readonly<Record<string, string>> | undefined,
): string {
  const entries = Object.entries(env ?? {});
  if (!entries.length) return command;
  const assignments = entries.map(([name, value]) => {
    if (!ENV_NAME.test(name)) throw new Error(`Invalid resume environment variable name: ${name}`);
    return `${name}=${shellQuote(value)}`;
  });
  return `${assignments.join(' ')} ${command}`;
}
