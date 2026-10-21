import { describe, it, expect } from 'vitest';
import {
  parseDumpLayoutPanes,
  parseListPanesJson,
  joinPanes,
} from '../src/core/zellij-session-discovery.js';
import { alignmentPanes } from '../src/core/zellij-adopt-discovery.js';

// Real `zellij action dump-layout` output (zellij 0.44.1): a default shell pane
// where the user interactively typed `claude` (terminal_0) split vertically with
// a `zellij run codex` pane (terminal_1), plus tab-bar/status-bar/about plugins
// and the template tail. The crux: zellij's resurrection introspection captured
// `command="claude"` for the INTERACTIVELY-typed CLI (list-panes shows null).
const DUMP_LAYOUT = `layout {
    cwd "/tmp"
    tab name="Tab #1" hide_floating_panes=true {
        pane size=1 borderless=true {
            plugin location="zellij:tab-bar"
        }
        pane split_direction="vertical" {
            pane command="claude" cwd="zjproj" size="50%" {
                args "5000"
                start_suspended true
            }
            pane command="codex" name="codexpane" cwd="zjproj2" size="50%" {
                args "6000"
                start_suspended true
            }
        }
        pane size=1 borderless=true {
            plugin location="zellij:status-bar"
        }
        floating_panes {
            pane {
                height 20
                plugin location="zellij:about" {
                    is_startup_tip "true"
                }
            }
        }
    }
    new_tab_template {
        pane size=1 borderless=true {
            plugin location="zellij:tab-bar"
        }
        pane
        pane size=1 borderless=true {
            plugin location="zellij:status-bar"
        }
    }
    swap_tiled_layout name="vertical" {
        tab max_panes=5 {
            pane command="should-be-ignored" {
            }
        }
    }
}`;

// Real `list-panes --json` shape (trimmed to the fields the parser reads).
const LIST_PANES_JSON = JSON.stringify([
  { id: 0, is_plugin: true, title: '(.) - zellij:link', terminal_command: null },
  { id: 3, is_plugin: true, title: 'about', terminal_command: null },
  { id: 0, is_plugin: false, title: 'Pane #1', terminal_command: null },
  { id: 1, is_plugin: false, title: 'codexpane', terminal_command: '/tmp/zjproj2/fakecodex' },
]);

describe('parseDumpLayoutPanes', () => {
  it('extracts only command panes, with resolved cwd and args', () => {
    const panes = parseDumpLayoutPanes(DUMP_LAYOUT);
    expect(panes).toHaveLength(2);

    expect(panes[0]).toMatchObject({
      command: 'claude',
      cwd: '/tmp/zjproj',          // layout base "/tmp" + pane cwd "zjproj"
      args: ['5000'],
    });
    expect(panes[1]).toMatchObject({
      command: 'codex',
      name: 'codexpane',
      cwd: '/tmp/zjproj2',
      args: ['6000'],
    });
  });

  it('ignores plugin panes (tab-bar / status-bar / about)', () => {
    const commands = parseDumpLayoutPanes(DUMP_LAYOUT).map(p => p.command);
    expect(commands).not.toContain('');
    expect(commands).toEqual(['claude', 'codex']);
  });

  it('truncates at template sections so swap_tiled_layout panes are excluded', () => {
    const commands = parseDumpLayoutPanes(DUMP_LAYOUT).map(p => p.command);
    expect(commands).not.toContain('should-be-ignored');
  });

  it('handles an absolute pane cwd without joining the base', () => {
    const kdl = `layout {
    cwd "/home/u"
    tab {
        pane command="claude" cwd="/srv/work" {
        }
    }
}`;
    expect(parseDumpLayoutPanes(kdl)[0]!.cwd).toBe('/srv/work');
  });

  it('unescapes KDL-escaped quotes/backslashes in attrs and args', () => {
    // zellij serialises a value `say "hi"` as `"say \"hi\""` and `back\slash`
    // as `"back\\slash"`. The parser must reverse both.
    const kdl = `layout {
    cwd "/h"
    tab {
        pane command="my cli" cwd="/p/a b" {
            args "--msg" "say \\"hi\\"" "back\\\\slash"
        }
    }
}`;
    const p = parseDumpLayoutPanes(kdl)[0]!;
    expect(p.command).toBe('my cli');
    expect(p.cwd).toBe('/p/a b');
    expect(p.args).toEqual(['--msg', 'say "hi"', 'back\\slash']);
  });
});

describe('parseListPanesJson', () => {
  it('maps ids to terminal_<n> and flags plugins', () => {
    const panes = parseListPanesJson(LIST_PANES_JSON);
    const terminals = panes.filter(p => !p.isPlugin);
    expect(terminals.map(p => p.paneId)).toEqual(['terminal_0', 'terminal_1']);
    expect(panes.filter(p => p.isPlugin)).toHaveLength(2);
  });

  it('returns [] for malformed json', () => {
    expect(parseListPanesJson('not json')).toEqual([]);
  });

  it('flags exited held panes (zellij run command finished)', () => {
    const panes = parseListPanesJson(JSON.stringify([
      { id: 0, is_plugin: false, exited: false },
      { id: 3, is_plugin: false, exited: true, is_held: true, terminal_command: 'sleep 2' },
    ]));
    expect(panes.map(p => p.exited)).toEqual([false, true]);
  });
});

// Real bug repro (zellij 0.44.1, verified live): the adopt alignment set must
// contain exactly the terminal panes that have a live process behind them —
// floating panes DO (their shell is a server child), exited held panes DON'T.
// Getting either wrong flips the count guard and hides EVERY CLI in the session.
describe('alignmentPanes', () => {
  const LISTED = parseListPanesJson(JSON.stringify([
    { id: 0, is_plugin: true, title: '(.) - zellij:link' },          // plugin → out
    { id: 2, is_plugin: false, is_floating: true },                  // floating shell → IN
    { id: 0, is_plugin: false, title: '✳ Claude Code' },             // tiled CLI → IN
    { id: 3, is_plugin: false, exited: true, is_held: true },        // exited held → out
    { id: 1, is_plugin: false },                                     // tiled shell → IN
  ]));

  it('keeps floating panes, drops exited/plugin panes, sorts by pane id', () => {
    expect(alignmentPanes(LISTED).map(p => p.paneId))
      .toEqual(['terminal_0', 'terminal_1', 'terminal_2']);
  });

  it('matches the live-process count 1:1 (the count-guard invariant)', () => {
    // 3 live pane processes (t0 claude, t1 shell, t2 floating shell) — the
    // old filter yielded 2 (floating dropped) or 3-with-exited, both refusing.
    expect(alignmentPanes(LISTED)).toHaveLength(3);
  });
});

describe('joinPanes', () => {
  it('binds the i-th command pane to the i-th terminal pane id (order join)', () => {
    const discovered = joinPanes(
      'bmx-abc',
      parseDumpLayoutPanes(DUMP_LAYOUT),
      parseListPanesJson(LIST_PANES_JSON),
    );
    expect(discovered).toEqual([
      { session: 'bmx-abc', paneId: 'terminal_0', command: 'claude', cwd: '/tmp/zjproj', args: ['5000'], title: 'Pane #1' },
      { session: 'bmx-abc', paneId: 'terminal_1', command: 'codex', cwd: '/tmp/zjproj2', args: ['6000'], title: 'codexpane' },
    ]);
  });

  it('drops command panes with no matching terminal id', () => {
    const layout = parseDumpLayoutPanes(DUMP_LAYOUT);
    const onlyOne = parseListPanesJson(JSON.stringify([{ id: 0, is_plugin: false, title: 'Pane #1' }]));
    expect(joinPanes('s', layout, onlyOne)).toHaveLength(1);
  });
});
