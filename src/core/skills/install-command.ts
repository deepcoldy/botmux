const SKILLS_COMMAND_FLAGS = new Set(['-y', '--yes', '-g', '--global']);

/** Minimal shell-like tokenizer for pasted install commands. It removes quote
 * delimiters and honors backslash escapes, but never executes or expands the
 * input. Malformed quoting is rejected instead of guessing at a source. */
function tokenizeInstallCommand(raw: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  let started = false;

  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (quote) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      if (char === '\\' && quote === '"') {
        if (index + 1 >= raw.length) return null;
        current += raw[++index];
        continue;
      }
      current += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === '\\') {
      if (index + 1 >= raw.length) return null;
      current += raw[++index];
      started = true;
      continue;
    }
    current += char;
    started = true;
  }

  if (quote) return null;
  if (started) tokens.push(current);
  return tokens;
}

function firstSourceToken(tokens: string[]): string | null {
  for (const token of tokens) {
    if (SKILLS_COMMAND_FLAGS.has(token)) continue;
    // Unknown options may take values. Fail closed rather than accidentally
    // treating an option or its value as the repository source.
    if (token.startsWith('-')) return null;
    return token || null;
  }
  return null;
}

/** Extract the source argument from supported vercel-labs/skills commands.
 * `-g`/`--global` and `-y`/`--yes` are accepted before or after the source. */
export function extractSkillsInstallCommandSource(raw: string): string | null {
  const tokens = tokenizeInstallCommand(raw);
  if (!tokens) return null;
  const binIndex = tokens.findIndex((token) => (
    token === 'skills'
    || token === 'add-skill'
    || token.startsWith('skills@')
  ));
  if (binIndex < 0) return null;

  const bin = tokens[binIndex];
  const rest = tokens.slice(binIndex + 1);
  if (bin === 'add-skill') return firstSourceToken(rest);

  let commandIndex = 0;
  while (SKILLS_COMMAND_FLAGS.has(rest[commandIndex])) commandIndex++;
  if (rest[commandIndex] !== 'add') return null;
  return firstSourceToken(rest.slice(commandIndex + 1));
}
