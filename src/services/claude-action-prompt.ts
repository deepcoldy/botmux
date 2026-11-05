/** A narrow, read-only projection of Claude Code's own permission dialog.
 * Never copy the tool arguments or arbitrary terminal output into Lark.
 *
 * A match requires all of, together: a "Do you want to …?" question line, a
 * "1." plus "2." choice below it, and the dialog footer ("Esc to cancel")
 * below the choices. Chat text that merely quotes numbered options has no
 * footer, and a dialog half-scrolled out of the viewport loses one of the
 * three, so neither projects. The dialog body — command text, diff, warning
 * detail with target paths — sits above the question and never enters the
 * projection. */
const TITLES = ['Bash command', 'Multi Edit file', 'Edit file', 'Create file', 'Read file', 'Fetch', 'Web search'];

const QUESTION_RE = /^Do you want to [^?]{0,400}\?$/;
const CHOICE_RE = /^[>❯●]?\s*([1-4])\.\s+(.{1,100})$/;
const FOOTER_RE = /^Esc to cancel\b/;

/** A narrow terminal wraps a long question ("Do you want to make this edit to
 * <long path>?") over several rows, so no single row matches QUESTION_RE and the
 * dialog never reaches Lark. Re-join up to 3 continuation rows, only when the
 * joined text ends in "?" and a choice row follows directly. */
function joinWrappedQuestion(lines: string[]): string[] {
  const out = [...lines];
  for (let i = 0; i < out.length; i++) {
    if (!/^Do you want\b/.test(out[i]) || out[i].endsWith('?')) continue;
    for (let j = i + 1; j <= i + 3 && j < out.length; j++) {
      // A blank row, a choice row, or a row that is already a complete
      // question ends the search: never swallow a valid question line.
      if (!out[j] || CHOICE_RE.test(out[j]) || QUESTION_RE.test(out[j])) break;
      if (out[j].endsWith('?') && CHOICE_RE.test(out[j + 1] ?? '')) {
        const joined = out.slice(i, j + 1).join(' ');
        if (QUESTION_RE.test(joined)) out.splice(i, j - i + 1, joined);
        break;
      }
    }
  }
  return out;
}

export function claudeActionPrompt(screen: string): string | undefined {
  const lines = joinWrappedQuestion(
    screen.trimEnd().split('\n').slice(-35).map(line => line.replace(/[│┃╭╮╰╯┌┐└┘─━╌]/g, ' ').trim()),
  );
  let questionIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (QUESTION_RE.test(lines[i])) {
      questionIndex = i;
      break;
    }
  }
  if (questionIndex < 0) return;
  const tail = lines.slice(questionIndex + 1);
  const footerIndex = tail.findIndex(line => FOOTER_RE.test(line));
  if (footerIndex < 0) return;
  const choices = tail.slice(0, footerIndex)
    .map(line => CHOICE_RE.exec(line))
    .filter((match): match is RegExpExecArray => !!match);
  if (choices.length < 2 || choices[0][1] !== '1' || choices[1][1] !== '2') return;
  // Scan upward from the question: the dialog title (e.g. "Bash command",
  // optionally with a " · …" suffix such as provenance from a fork agent).
  // A long command body can push the title out of this window, and new tools
  // bring unknown titles — the question+choices+footer triple above is
  // already strict, so fall back to a generic title instead of dropping the
  // dialog (a less specific notification beats a silent stall).
  let titleLine: string | undefined;
  for (let i = questionIndex - 1; i >= Math.max(0, questionIndex - 15); i--) {
    if (TITLES.some(item => lines[i] === item || lines[i].startsWith(item + ' ·'))) {
      titleLine = lines[i];
      break;
    }
  }
  const title = (titleLine ?? '权限确认').slice(0, 80);
  const question = lines[questionIndex].slice(0, 180);
  return `Claude 正等待你确认「${title}」：${question}\n${choices.slice(0, 4).map(match => `${match[1]}. ${match[2]}`).join('\n')}\n请在原终端核对具体操作后选择。`;
}
