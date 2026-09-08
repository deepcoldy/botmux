/**
 * 保留命令表的子集不变量。
 *
 * `reservedCommandKind` 只查 `DAEMON_COMMANDS` 一张表就覆盖了三张 daemon 命令表，
 * 这个简化只在 `SESSIONLESS_DAEMON_COMMANDS` 与
 * `EXISTING_SESSION_ONLY_DAEMON_COMMANDS` 保持子集时成立。往其中一张单独加命令
 * 会静默打开一个免@ 缺口，所以在这里钉死。
 *
 * 单独一个文件、**不 mock 任何模块**：这条断言要 import `command-handler`（整个
 * daemon 模块图），而 command-trigger.test.ts 把 `bot-registry` 整个替换成了只有
 * `getBot` 的假模块 —— 图里任何一处静态具名 import 在 bun 腿的 ESM 链接期就会
 * SyntaxError（实测 `export 'LarkTransportDisabledError' not found`）。
 */
import { describe, it, expect } from 'vitest';
import { DAEMON_COMMANDS } from '../src/core/passthrough-commands.js';
import { SESSIONLESS_DAEMON_COMMANDS, EXISTING_SESSION_ONLY_DAEMON_COMMANDS } from '../src/core/command-handler.js';

describe('reserved daemon command tables', () => {
  it('keeps SESSIONLESS_DAEMON_COMMANDS a subset of DAEMON_COMMANDS', () => {
    for (const cmd of SESSIONLESS_DAEMON_COMMANDS) expect(DAEMON_COMMANDS.has(cmd)).toBe(true);
  });

  it('keeps EXISTING_SESSION_ONLY_DAEMON_COMMANDS a subset of DAEMON_COMMANDS', () => {
    for (const cmd of EXISTING_SESSION_ONLY_DAEMON_COMMANDS) expect(DAEMON_COMMANDS.has(cmd)).toBe(true);
  });

  // Membership, not just the subset relation above — dropping a member still
  // satisfies "subset", so the subset test cannot protect any individual entry.
  //
  // `/quote` in particular: without it the router falls through to
  // `sessionStore.createSession` and a first-in-a-new-topic `/quote` builds a
  // `worker: null` session. confirm then finds that session, cold-forks it with
  // a FOLLOW-UP input, and `<botmux_routing>` / `<identity>` — generated only by
  // `buildNewTopicCliInput` — never reach the CLI. `markInitialUserTurnPending`
  // is not set either, so the next real user message is also treated as a
  // follow-up and the opening context is unrecoverable. Severity splits by CLI:
  // adapters with `injectsSessionContext` get those blocks from the spawn-time
  // system prompt, the rest lose them permanently.
  //
  // Being existing-session-only is also the correct semantics: confirm needs a
  // session to inject into, and `card.quote.toast_no_session` is already the
  // graceful failure for having none.
  it('keeps /quote existing-session-only (guards the ghost-session regression)', () => {
    expect(EXISTING_SESSION_ONLY_DAEMON_COMMANDS.has('/quote')).toBe(true);
  });
});
