export interface FleetCommandSpec {
  boolFlags?: readonly string[];
  valueFlags?: readonly string[];
  maxPositionalArgs?: number;
}

/** Return tokens not accepted by a fleet command, consuming values for flags. */
export function unknownFleetArgs(args: readonly string[], spec: FleetCommandSpec): string[] {
  const boolFlags = new Set(spec.boolFlags ?? []);
  const valueFlags = new Set(spec.valueFlags ?? []);
  const maxPositional = spec.maxPositionalArgs ?? 0;
  let positionalCount = 0;
  const unknown: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (boolFlags.has(arg) || arg === '--help' || arg === '-h') continue;
    const equalsName = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : undefined;
    if (equalsName && valueFlags.has(equalsName)) continue;
    if (valueFlags.has(arg)) {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) unknown.push(arg);
      else i += 1;
      continue;
    }
    if (!arg.startsWith('-') && positionalCount < maxPositional) {
      positionalCount += 1;
      continue;
    }
    unknown.push(arg);
  }
  return unknown;
}
