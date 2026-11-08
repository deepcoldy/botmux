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
/** A "Do you want" row that is NOT a complete question — a wrapped question's
 * head row, or dialog body text that happens to start the same way. */
const QUESTION_HEAD_RE = /^Do you want\b/;
/** Rows between an unresolved head and the footer that still read as one
 * compact permission dialog. At the 80-col adopt floor a ~340-char question
 * wraps to 5 rows and the 4-choice variant's option 3 wraps to 2 rows, putting
 * the footer 11 rows under the head — 13 covers that with a one-row margin.
 * Deliberately far smaller than the 35-row viewport window in
 * projectDialogLines: the two bounds serve different questions (is the dialog
 * on screen vs. is this one compact block), keep them apart on purpose and
 * change both together if the dialog layout ever grows. */
const UNRESOLVED_HEAD_WINDOW = 13;

/** Last 35 viewport rows with box-drawing characters blanked and ends trimmed.
 * This is the projection's "dialog fully on screen" bound; the gate-only
 * compact-block bound lives at UNRESOLVED_HEAD_WINDOW. */
function projectDialogLines(screen: string): string[] {
  return screen.trimEnd().split('\n').slice(-35)
    .map(line => line.replace(/[│┃╭╮╰╯┌┐└┘─━╌]/g, ' ').trim());
}

/** A narrow terminal wraps a long question ("Do you want to make this edit to
 * <long path>?") over several rows, so no single row matches QUESTION_RE and the
 * dialog never reaches Lark. Re-join up to 3 continuation rows, only when the
 * joined text ends in "?" and a choice row follows directly.
 *
 * Scan BOTTOM-UP, deliberately: the real question always sits BELOW the dialog
 * body, and a diff's last line is rendered directly above it with no blank row,
 * so "the row above is blank" cannot anchor the join. When the body itself
 * contains a row starting "Do you want" (the │ prefix is stripped away), the
 * real question is joined first; the body row then meets the "already a
 * complete question" stop and can never anchor a join that pulls body text —
 * including command text — into the projection. splice() only removes rows at
 * or below the current index, so decrementing indices stay valid. */
function joinWrappedQuestion(lines: string[]): string[] {
  const out = [...lines];
  for (let i = out.length - 1; i >= 0; i--) {
    if (!QUESTION_HEAD_RE.test(out[i]) || out[i].endsWith('?')) continue;
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

/** Conservative permission-dialog signal for the keep-alive gate.
 *
 * claudeActionPrompt only recognises a question it could fully reconstruct; a
 * dialog wrapped beyond the join window (or past the 400-char cap) stays
 * silent there — but the gate must fail closed regardless: an unattended Enter
 * on that screen selects the highlighted choice. Require the same hard
 * evidence as the projection (a "1." + "2." pair and the Esc footer, in a
 * compact block below an unresolved "Do you want" head row). The notification
 * path must NOT use this: a false positive there would send a false alarm,
 * while here it only skips one cache keep-alive.
 *
 * This window and the projection's 35-row viewport (projectDialogLines) answer
 * different questions and are intentionally not shared: 35 rows = "is the
 * dialog fully on screen" (for readable projection), UNRESOLVED_HEAD_WINDOW =
 * "is this one compact block" (for the gate). When one changes, re-check the
 * other so the gate cannot stay refused on a dialog the notification can never
 * send (or vice versa). */
export function screenHasUnresolvedPermissionQuestion(screen: string): boolean {
  const lines = projectDialogLines(screen);
  for (let i = 0; i < lines.length; i++) {
    if (!QUESTION_HEAD_RE.test(lines[i]) || lines[i].endsWith('?')) continue;
    const tail = lines.slice(i + 1, i + 1 + UNRESOLVED_HEAD_WINDOW);
    const footerIndex = tail.findIndex(line => FOOTER_RE.test(line));
    if (footerIndex < 0) continue;
    const choices = tail.slice(0, footerIndex)
      .map(line => CHOICE_RE.exec(line))
      .filter((match): match is RegExpExecArray => !!match);
    if (choices.length >= 2 && choices[0][1] === '1' && choices[1][1] === '2') return true;
  }
  return false;
}

/** The real dialog replaces the composer, so its footer is the bottom row;
 * text below the footer means the reply transcript quotes a dialog. The
 * keep-alive gate passes `footerAnywhere` because it fails closed on any
 * dialog evidence (see screenHasUnresolvedPermissionQuestion). */
export function claudeActionPrompt(screen: string, { footerAnywhere = false } = {}): string | undefined {
  const lines = joinWrappedQuestion(projectDialogLines(screen));
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
  if (!footerAnywhere && tail.slice(footerIndex + 1).some(Boolean)) return;
  // An unresolved "Do you want" head between the selected question and the
  // footer means a real (wrapped, un-rejoinable) question sits BELOW the
  // selected one — the selected line is dialog body, never the question.
  // Projecting it would leak the command body into Lark; refuse instead.
  if (tail.slice(0, footerIndex).some(line => QUESTION_HEAD_RE.test(line) && !line.endsWith('?'))) return;
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
  // Keep the TAIL within the display budget: the file name the user must
  // identify — and the closing "?" — end the question. With QUESTION_RE capped
  // at 140 a head-only slice never triggered; the 400 cap makes it fire, and
  // cutting the head hides precisely the long path this projection exists to
  // surface (issue #2879).
  const fullQuestion = lines[questionIndex];
  // Slice by code points, not UTF-16 units: a unit-based slice can leave a
  // lone surrogate at the ellipsis boundary.
  const questionChars = Array.from(fullQuestion);
  const question = questionChars.length > 180
    ? `…${questionChars.slice(-179).join('')}`
    : fullQuestion;
  return `Claude 正等待你确认「${title}」：${question}\n${choices.slice(0, 4).map(match => `${match[1]}. ${match[2]}`).join('\n')}\n请在原终端核对具体操作后选择。`;
}
