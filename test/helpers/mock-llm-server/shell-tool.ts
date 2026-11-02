/**
 * Picks the shell tool a CLI advertises and builds the arguments for one
 * command call. CLIs name it differently (Claude `Bash`, Kimi `Bash`, Pi /
 * OpenCode / Oh My Pi `bash`, Grok `run_terminal_command`, Antigravity
 * `run_command`), some name the command field differently (Antigravity
 * `CommandLine`) and some reject a call that leaves out a required field
 * (Grok's `description`, Antigravity's `toolSummary` / `WaitMsBeforeAsync`),
 * so neither the name nor `{ command }` alone is enough.
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

/** Tool declarations of any wire format: Anthropic, OpenAI chat, Gemini API (Antigravity). */
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

/** Whether the request declares any callable function/tool at all. A group
 *  holding only a built-in (e.g. Gemini's `{googleSearch: {}}`) declares none. */
export function hasDeclaredFunctions(tools: unknown): boolean {
  return declarations(tools).length > 0;
}

// Exact names first: Claude also offers `BashOutput` and `KillShell`.
const EXACT = /^_?(bash|shell|run_command)$/i;
const LOOSE = /bash|shell|terminal/i;
const FILLER = 'botmux e2e reply';
/** Integer filler: Antigravity's `WaitMsBeforeAsync` (500–10000) — wait the longest so the reply is synchronous. */
const INT_FILLER = 10000;

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
  // `command` unless the tool names it otherwise (Antigravity `CommandLine`).
  const commandField = 'command' in properties
    ? 'command'
    : Object.keys(properties).find((k) => /^command/i.test(k) && properties[k]?.type === 'string') ?? 'command';
  return {
    name: tool.name,
    args(command: string) {
      const args: Record<string, unknown> = { [commandField]: command };
      for (const field of required) {
        if (typeof field !== 'string' || field in args) continue;
        if (properties[field]?.type === 'string') args[field] = FILLER;
        else if (properties[field]?.type === 'integer' || properties[field]?.type === 'number') args[field] = INT_FILLER;
      }
      return args;
    },
  };
}
