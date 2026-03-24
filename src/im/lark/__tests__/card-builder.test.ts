import { describe, it, expect } from 'vitest';
import {
  buildSessionCard,
  buildStreamingCard,
  buildRepoSelectCard,
} from '../card-builder.js';

describe('buildSessionCard', () => {
  it('returns valid JSON with header, elements, and session_id in button values', () => {
    const json = buildSessionCard('sess-1', 'om_root', 'https://term.example.com', 'My Session');
    const card = JSON.parse(json);

    expect(card.header).toBeDefined();
    expect(card.header.title.content).toContain('My Session');
    expect(card.header.template).toBe('blue');
    expect(card.elements).toBeInstanceOf(Array);
    expect(card.elements.length).toBeGreaterThan(0);

    // Action element should contain buttons
    const actionEl = card.elements.find((e: any) => e.tag === 'action');
    expect(actionEl).toBeDefined();
    expect(actionEl.actions.length).toBeGreaterThanOrEqual(2);

    // Terminal button has multi_url
    const termBtn = actionEl.actions[0];
    expect(termBtn.multi_url.url).toBe('https://term.example.com');

    // Close button carries session_id and root_id
    const closeBtn = actionEl.actions.find((b: any) => b.value?.action === 'close');
    expect(closeBtn).toBeDefined();
    expect(closeBtn.value.session_id).toBe('sess-1');
    expect(closeBtn.value.root_id).toBe('om_root');
  });

  it('includes get_write_link button when showManageButtons is false', () => {
    const json = buildSessionCard('sess-1', 'om_root', 'https://t.co', 'S', undefined, false);
    const card = JSON.parse(json);
    const actions = card.elements[0].actions;
    const writeLinkBtn = actions.find((b: any) => b.value?.action === 'get_write_link');
    expect(writeLinkBtn).toBeDefined();
  });

  it('includes restart button when showManageButtons is true', () => {
    const json = buildSessionCard('sess-1', 'om_root', 'https://t.co', 'S', undefined, true);
    const card = JSON.parse(json);
    const actions = card.elements[0].actions;
    const restartBtn = actions.find((b: any) => b.value?.action === 'restart');
    expect(restartBtn).toBeDefined();
    expect(restartBtn.text.content).toContain('Claude');
  });

  it('escapes Lark markdown special characters in title', () => {
    const json = buildSessionCard('s', 'r', 'u', 'title_with*special[chars]');
    const card = JSON.parse(json);
    expect(card.header.title.content).toContain('title\\_with\\*special\\[chars\\]');
  });
});

describe('buildStreamingCard', () => {
  it('returns JSON with header showing status and correct template color', () => {
    const json = buildStreamingCard('sess-1', 'om_root', 'https://t.co', 'Task', 'output', 'working');
    const card = JSON.parse(json);

    expect(card.header.title.content).toContain('Task');
    expect(card.header.title.content).toContain('工作中');
    expect(card.header.template).toBe('blue');
  });

  it('uses yellow template for starting status', () => {
    const json = buildStreamingCard('s', 'r', 'u', 't', '', 'starting');
    const card = JSON.parse(json);
    expect(card.header.template).toBe('yellow');
    expect(card.header.title.content).toContain('启动中');
  });

  it('uses green template for idle status', () => {
    const json = buildStreamingCard('s', 'r', 'u', 't', '', 'idle');
    const card = JSON.parse(json);
    expect(card.header.template).toBe('green');
    expect(card.header.title.content).toContain('就绪');
  });

  it('includes markdown content when expanded is true', () => {
    const json = buildStreamingCard('s', 'r', 'u', 't', 'hello world', 'working', undefined, true);
    const card = JSON.parse(json);
    const mdEl = card.elements.find((e: any) => e.tag === 'markdown');
    expect(mdEl).toBeDefined();
    expect(mdEl.content).toBe('hello world');
  });

  it('shows fallback text when expanded with empty content', () => {
    const json = buildStreamingCard('s', 'r', 'u', 't', '', 'working', undefined, true);
    const card = JSON.parse(json);
    const mdEl = card.elements.find((e: any) => e.tag === 'markdown');
    expect(mdEl).toBeDefined();
    expect(mdEl.content).toBe('(等待输出…)');
  });

  it('does not include markdown content when expanded is false', () => {
    const json = buildStreamingCard('s', 'r', 'u', 't', 'output', 'working', undefined, false);
    const card = JSON.parse(json);
    const mdEl = card.elements.find((e: any) => e.tag === 'markdown');
    expect(mdEl).toBeUndefined();
  });

  it('includes toggle, terminal, get_write_link, and close buttons', () => {
    const json = buildStreamingCard('sess-1', 'om_root', 'https://t.co', 'T', '', 'idle');
    const card = JSON.parse(json);
    const actionEl = card.elements.find((e: any) => e.tag === 'action');
    expect(actionEl.actions).toHaveLength(4);

    const actions = actionEl.actions.map((a: any) => a.value?.action ?? 'terminal');
    expect(actions).toContain('toggle_stream');
    expect(actions).toContain('get_write_link');
    expect(actions).toContain('close');
  });

  it('embeds cardNonce in toggle button value when provided', () => {
    const json = buildStreamingCard('s', 'r', 'u', 't', '', 'working', undefined, false, 'nonce-abc');
    const card = JSON.parse(json);
    const toggleBtn = card.elements.find((e: any) => e.tag === 'action')
      .actions.find((b: any) => b.value?.action === 'toggle_stream');
    expect(toggleBtn.value.card_nonce).toBe('nonce-abc');
  });

  it('omits cardNonce from toggle button when not provided', () => {
    const json = buildStreamingCard('s', 'r', 'u', 't', '', 'working');
    const card = JSON.parse(json);
    const toggleBtn = card.elements.find((e: any) => e.tag === 'action')
      .actions.find((b: any) => b.value?.action === 'toggle_stream');
    expect(toggleBtn.value.card_nonce).toBeUndefined();
  });
});

describe('buildRepoSelectCard', () => {
  const projects = [
    { name: 'proj-a', path: '/home/proj-a', type: 'repo' as const, branch: 'main' },
    { name: 'proj-b', path: '/home/proj-b', type: 'worktree' as const, branch: 'feat-x' },
  ];

  it('returns JSON with project list as dropdown options', () => {
    const json = buildRepoSelectCard(projects, '/home/proj-a', 'om_root');
    const card = JSON.parse(json);

    expect(card.header.title.content).toContain('项目仓库管理');

    const actionEl = card.elements.find((e: any) => e.tag === 'action');
    expect(actionEl).toBeDefined();
    const selectEl = actionEl.actions.find((a: any) => a.tag === 'select_static');
    expect(selectEl).toBeDefined();
    expect(selectEl.options).toHaveLength(2);
    expect(selectEl.options[0].text.content).toContain('proj-a');
    expect(selectEl.options[0].text.content).toContain('main');
    expect(selectEl.options[0].value).toBe('/home/proj-a');
  });

  it('marks the current path with arrow tag', () => {
    const json = buildRepoSelectCard(projects, '/home/proj-a');
    const card = JSON.parse(json);
    const selectEl = card.elements.find((e: any) => e.tag === 'action')
      .actions.find((a: any) => a.tag === 'select_static');
    expect(selectEl.options[0].text.content).toContain('当前');
    expect(selectEl.options[1].text.content).not.toContain('当前');
  });

  it('tags worktree projects', () => {
    const json = buildRepoSelectCard(projects);
    const card = JSON.parse(json);
    const selectEl = card.elements.find((e: any) => e.tag === 'action')
      .actions.find((a: any) => a.tag === 'select_static');
    expect(selectEl.options[1].text.content).toContain('[worktree]');
  });

  it('includes skip button with skip_repo action', () => {
    const json = buildRepoSelectCard(projects, undefined, 'om_root');
    const card = JSON.parse(json);
    const actionEl = card.elements.find((e: any) => e.tag === 'action');
    const skipBtn = actionEl.actions.find((a: any) => a.value?.action === 'skip_repo');
    expect(skipBtn).toBeDefined();
    expect(skipBtn.value.root_id).toBe('om_root');
  });

  it('shows current path as N/A when not provided', () => {
    const json = buildRepoSelectCard(projects);
    const card = JSON.parse(json);
    const divEl = card.elements.find((e: any) => e.tag === 'div');
    expect(divEl.text.content).toContain('N/A');
  });
});
