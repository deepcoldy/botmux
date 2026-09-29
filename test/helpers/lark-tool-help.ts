/** Representative Cobra help grammar, including value flags and local commands. */
const root = `Usage:
  lark-cli [command]
Available Commands:
  docs      Documents
  sheets    Sheets
  im        Messages
  auth      Authorization
  profile   Profiles
  config    Config
  update    Update
  schema    API schema
  skills    Skills
  event     Events
  doctor    Diagnostics
Flags:
  -h, --help             help
      --profile string   profile
  -v, --version          version
`;
const group = (name: string, commands: string[]) => `Usage:
  lark-cli ${name} [command]
Available Commands:
${commands.map(c => `  ${c}      command`).join('\n')}
Flags:
  -h, --help   help
Global Flags:
      --profile string   profile
`;
const leaf = (command: string, flags: string) => `Usage:
  lark-cli ${command} [flags]
Flags:
${flags}
  -h, --help   help
Global Flags:
      --profile string   profile
`;
export const LARK_TOOL_HELP: Record<string, string> = {
  '': root,
  docs: group('docs', ['+fetch']),
  sheets: group('sheets', ['+replace']),
  im: group('im', ['+send']),
  event: group('event', ['list', 'schema', 'consume']),
  auth: group('auth', ['login', 'status']),
  profile: group('profile', ['use']),
  config: group('config', ['init']),
  skills: group('skills', ['list', 'read', 'install']),
  'docs +fetch': leaf('docs +fetch', `      --as string      identity
      --doc string     document
      --scope string   scope
      --keyword string   keyword
      --dry-run        preview
  -q, --jq string      query`),
  'sheets +replace': leaf('sheets +replace', `      --as string       identity
      --replacement string   replacement
      --description string   description
      --dry-run         preview`),
  'im +send': leaf('im +send', `      --as string      identity
      --text string    text
      --dry-run        preview`),
  'event list': leaf('event list', '      --json   JSON'),
  'event schema': leaf('event schema', '      --json   JSON'),
  'event consume': leaf('event consume', '      --as string   identity\n      --dry-run   preview'),
  doctor: leaf('doctor', '      --offline   local checks'),
  'auth status': leaf('auth status', '      --json   JSON'),
  'auth login': leaf('auth login', '      --scope string   scope'),
  'profile use': leaf('profile use', ''),
  'config init': leaf('config init', ''),
  update: leaf('update', ''),
  schema: leaf('schema', ''),
  'skills list': leaf('skills list', ''),
  'skills read': leaf('skills read', ''),
  'skills install': leaf('skills install', ''),
};
export function readLarkToolHelp(command: readonly string[]): string {
  const text = LARK_TOOL_HELP[command.join(' ')];
  if (!text) throw new Error(`No fake command metadata: ${command.join(' ')}`);
  return text;
}

/** Node fixture to use from a cwd with no repository dependencies. */
export function fakeLarkHelpScript(): string {
  return `const help = ${JSON.stringify(LARK_TOOL_HELP)};
if (process.argv.includes('--help')) {
  process.stdout.write(help[process.argv.slice(2).filter(a=>a!=='--help').join(' ')] || help['']);
  process.exit(0);
}
`;
}
