export interface LarkToolInvocation {
  args: string[];
  mode: 'bot' | 'user';
  offline: boolean;
  supportsAs: boolean;
  showHelp: boolean;
  /** Index of the actual flag terminator, excluding '--' used as a value. */
  literalIndex: number;
}

interface CommandHelp {
  flags: Map<string, { name: string; takesValue: boolean }>;
  commands: Set<string>;
  usage: string;
}

/** Read flag arity from this exact CLI version, including shortcut aliases.
 * Never infer arity from the spelling of a business argument's value. */
function parseHelp(text: string): CommandHelp {
  const flags: CommandHelp['flags'] = new Map();
  const commands = new Set<string>();
  let section = '';
  for (const line of text.split('\n')) {
    if (/^(Available Commands|Additional Commands|Lark domains|Agent tooling|CLI management):/.test(line)) section = 'commands';
    else if (/^(Global Flags|Flags|Inherited Flags):/.test(line)) section = 'flags';
    else if (/^\S/.test(line)) section = '';
    // Typed API commands group flags under API Parameters/Execution/Output,
    // while shortcuts use Flags. Both use the same declaration grammar.
    if (section !== 'commands') {
      const match = /^\s+(?:(-[A-Za-z0-9]),\s+)?(--[A-Za-z0-9-]+)(?: ([^\s]+))?\s{2,}/.exec(line);
      if (!match) continue;
      const flag = { name: match[2], takesValue: !!match[3] && !match[3].startsWith('[') };
      flags.set(match[2], flag);
      if (match[1]) flags.set(match[1], flag);
    } else if (section === 'commands') {
      const match = /^\s+([+\w][\w.+-]*)\s{2,}/.exec(line);
      if (match) commands.add(match[1]);
    }
  }
  const usage = /(?:^|\n)Usage:\s*\n\s+([^\n]+)/.exec(text)?.[1]?.trim();
  if (!usage || !flags.has('--help')) throw new Error('Cannot read lark-cli command metadata; command not executed');
  return { flags, commands, usage };
}

/** Resolve commands through help only. Business arguments never enter a help
 * probe; all execution happens later with argv preserved exactly. */
export function parseLarkToolInvocation(
  args: readonly string[],
  binding: { appId: string; defaultAs: 'bot' | 'user' },
  readHelp: (command: readonly string[]) => string,
): LarkToolInvocation {
  const output: string[] = [], command: string[] = [];
  let metadata = parseHelp(readHelp(command));
  let mode = binding.defaultAs, sawAs = false, sawProfile = false;
  let showHelp = false, version = false, doctorOffline = false, literalIndex = -1;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      literalIndex = output.length;
      output.push(...args.slice(i));
      break;
    }
    if (arg.startsWith('-') && arg !== '-') {
      const eq = arg.indexOf('=');
      const flagName = eq < 0 ? arg : arg.slice(0, eq);
      let flag = metadata.flags.get(flagName);
      let inlineValue = eq < 0 ? undefined : arg.slice(eq + 1);
      if (!flag && /^-[^-].+/.test(arg)) {
        flag = metadata.flags.get(arg.slice(0, 2));
        if (!flag?.takesValue) throw new Error(`Unsupported flag form ${arg}; use separate flags`);
        inlineValue = arg.slice(2);
      }
      // --as may precede subcommands; its support is checked on the final command.
      if (!flag && flagName === '--as') flag = { name: '--as', takesValue: true };
      if (!flag) throw new Error(`Unknown lark-cli flag ${flagName}; command not executed`);
      let value = inlineValue;
      if (flag.takesValue && value === undefined) {
        if (i + 1 >= args.length) throw new Error(`${flagName} requires a value`);
        value = args[++i];
      }
      if (flag.name === '--as') {
        if (sawAs || (value !== 'bot' && value !== 'user')) throw new Error('Use exactly one --as bot or --as user');
        sawAs = true; mode = value; continue;
      }
      if (flag.name === '--profile') {
        if (sawProfile || value !== binding.appId) throw new Error(`lark-cli is bound to application ${binding.appId}; profile switching is unavailable`);
        sawProfile = true; continue;
      }
      if (flag.name === '--help') showHelp = value !== 'false';
      if (flag.name === '--version') version = value !== 'false';
      if (flag.name === '--offline') doctorOffline = value !== 'false';
      output.push(arg);
      if (flag.takesValue && inlineValue === undefined) output.push(value!);
      continue;
    }
    if (metadata.commands.size > 0) {
      // Hidden aliases may not appear in Available Commands. A help probe must
      // resolve a different usage; Cobra otherwise returns the parent help.
      const next = parseHelp(readHelp([...command, arg]));
      if (!metadata.commands.has(arg) && next.usage === metadata.usage) {
        throw new Error(`Unknown lark-cli command ${arg}`);
      }
      command.push(arg); metadata = next;
    }
    output.push(arg);
  }
  const root = command[0], sub = command[1];
  const offline = showHelp || version || !root || metadata.commands.size > 0 || root === 'help' || root === 'schema'
    || root === 'skills' && ['read', 'list'].includes(sub)
    || root === 'event' && ['list', 'schema'].includes(sub)
    || root === 'doctor' && doctorOffline;
  const supportsAs = metadata.flags.has('--as');
  if (sawAs && !supportsAs && !showHelp) throw new Error('This lark-cli command does not accept --as');
  if (!offline && ['auth', 'profile', 'config', 'update'].includes(root)
    && !(root === 'auth' && sub === 'status')) {
    throw new Error('Managed lark-cli cannot change accounts. For this application authorization use botmux auth request --scope "<required scopes>" --json');
  }
  return { args: output, mode, offline, supportsAs, showHelp, literalIndex };
}

export function larkToolExecutionArgs(invocation: LarkToolInvocation): string[] {
  const args = [...invocation.args];
  if (!invocation.offline && invocation.supportsAs) {
    args.splice(invocation.literalIndex < 0 ? args.length : invocation.literalIndex, 0, '--as', invocation.mode);
  }
  return args;
}
