/**
 * Picks the shell tool a CLI advertises and builds the arguments for one
 * command call. CLIs name it differently (Claude `Bash`, Kimi `Bash`, Pi /
 * OpenCode / Oh My Pi `bash`, Grok `run_terminal_command`, Gemini
 * `run_shell_command`) and some reject a call that leaves out a required
 * field (Grok's `description`), so neither the name nor `{ command }` alone is
 * enough.
 */

export interface ShellTool {
  name: string;
  /** Arguments for running `command`: required string fields get a short filler. */
  args(command: string): Record<string, unknown>;
}

interface Declared {
  name: string;
  schema: { properties?: Record<string, { type?: unknown }>; required?: unknown } | undefined;
}

/** Tool declarations of any wire format: Anthropic, OpenAI chat, Gemini. */
function declarations(tools: unknown): Declared[] {
  if (!Array.isArray(tools)) return [];
  const out: Declared[] = [];
  for (const tool of tools as any[]) {
    if (Array.isArray(tool?.functionDeclarations)) {
      for (const fn of tool.functionDeclarations) {
        if (typeof fn?.name === 'string') out.push({ name: fn.name, schema: fn.parametersJsonSchema ?? fn.parameters });
      }
    } else if (typeof tool?.function?.name === 'string') {
      out.push({ name: tool.function.name, schema: tool.function.parameters });
    } else if (typeof tool?.name === 'string') {
      out.push({ name: tool.name, schema: tool.input_schema });
    }
  }
  return out;
}

// Exact names first: Claude also offers `BashOutput` and `KillShell`.
const EXACT = /^_?(bash|shell)$/i;
const LOOSE = /bash|shell|terminal/i;
const FILLER = 'botmux e2e reply';

/**
 * The shell tool among `tools`. A request that declares no tools at all gets
 * `fallbackName` with `{ command }` (what the mock always answered); one that
 * declares tools but no shell (Grok's title call offers only `session_title`)
 * gets null, so the caller answers with text instead of an unknown tool.
 */
export function pickShellTool(tools: unknown, fallbackName: string): ShellTool | null {
  const declared = declarations(tools);
  if (declared.length === 0) return { name: fallbackName, args: (command) => ({ command }) };
  const tool = declared.find((d) => EXACT.test(d.name)) ?? declared.find((d) => LOOSE.test(d.name) && !/kill|output/i.test(d.name));
  if (!tool) return null;
  const required = Array.isArray(tool.schema?.required) ? (tool.schema!.required as unknown[]) : [];
  const properties = tool.schema?.properties ?? {};
  return {
    name: tool.name,
    args(command: string) {
      const args: Record<string, unknown> = { command };
      for (const field of required) {
        if (typeof field !== 'string' || field in args) continue;
        if (properties[field]?.type === 'string') args[field] = FILLER;
      }
      return args;
    },
  };
}
