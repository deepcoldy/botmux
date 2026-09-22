import { describe, expect, it, vi } from 'vitest';
import { prepareForkTopic } from '../src/im/lark/fork-topic.js';
import { parseApiMessage, parseEventMessage } from '../src/im/lark/message-parser.js';

const body = {
  title: '',
  content: [
    [{ tag: 'at', user_id: 'ou_bot' }, { tag: 'text', text: ' /fork 开始新一轮评测，结果记录在' },
      { tag: 'a', text: '评测题库与记录', href: 'https://example.com/wiki/abc?table=xyz' }],
    [{ tag: 'img', image_key: 'img_source' }],
    [{ tag: 'text', text: '保留失败证据', style: ['bold'] }],
  ],
};
function message(raw: string) {
  return parseEventMessage({
    sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
    message: { message_id: 'om_command', message_type: 'post', content: raw,
      chat_id: 'oc_test', chat_type: 'group', create_time: '1000' },
  }).parsed;
}
function deps() {
  return {
    download: vi.fn(async () => ({ attachments: [{ type: 'image' as const, name: 'img_source.jpg', path: '/tmp/source.jpg' }] })),
    upload: vi.fn(async () => 'img_owned_by_bot'),
    imageUnavailable: '图片预览不可用，请返回主话题查看原图。',
    fallbackTitle: '分身任务',
  };
}

describe('fork topic presentation', () => {
  it.each([body, { zh_cn: body }, { en_us: body }])('preserves links and inline images from event posts', async post => {
    const msg = message(JSON.stringify(post));
    const io = deps();
    const result = await prepareForkTopic(msg.content.replace('/fork ', ''), msg, io);
    expect(result.title).toContain('评测题库与记录');
    expect(result.title).not.toMatch(/https|图片|\/fork/);
    expect(result.content).toEqual([
      [{ tag: 'text', text: '开始新一轮评测，结果记录在' }, body.content[0][2]],
      [{ tag: 'img', image_key: 'img_owned_by_bot' }],
      body.content[2],
    ]);
    expect(io.download).toHaveBeenCalledWith([{ type: 'image', key: 'img_source', name: 'img_source.jpg' }]);
    expect(io.upload).toHaveBeenCalledWith('/tmp/source.jpg');
    expect(result.attachments).toHaveLength(1);
  });

  it('retains raw post data from API reads too', () => {
    const raw = JSON.stringify(body);
    expect(parseApiMessage({ msg_type: 'post', body: { content: raw } }).rawPostContent).toBe(raw);
  });

  it('keeps the full multiline task while limiting the title by Unicode characters', async () => {
    const task = `${'😀'.repeat(90)} https://example.com/very-long\nsecond line\n\nlast line [图片 1]`;
    const msg = { ...message('{}'), rawPostContent: undefined };
    const result = await prepareForkTopic(task, msg, deps());
    expect(Array.from(result.title)).toHaveLength(60);
    expect(result.title.endsWith('…')).toBe(true);
    expect(result.content.map(row => row[0].text)).toEqual(task.split('\n').map(x => x || ' '));
  });

  it('keeps downloadable attachments for the agent when image upload fails', async () => {
    const msg = message(JSON.stringify(body));
    const io = deps();
    io.upload.mockRejectedValue(new Error('upload failed'));
    const result = await prepareForkTopic('task', msg, io);
    expect(result.content[1]).toEqual([{ tag: 'text', text: io.imageUnavailable }]);
    expect(result.attachments).toHaveLength(1);
  });

  it('does not break topic creation when an image could not be downloaded', async () => {
    const io = deps();
    io.download.mockResolvedValue({ attachments: [] });
    const result = await prepareForkTopic('task', message(JSON.stringify(body)), io);
    expect(result.content[1][0].text).toBe(io.imageUnavailable);
    expect(io.upload).not.toHaveBeenCalled();
  });

  it('strips /fork from a post title and avoids replaying body mentions', async () => {
    const msg = message(JSON.stringify({ title: '/fork 检查', content: [[{ tag: 'at', user_id: 'all' }]] }));
    const result = await prepareForkTopic('检查 @all', msg, deps());
    expect(result.content).toEqual([[{ tag: 'text', text: '检查' }], [{ tag: 'text', text: '@all' }]]);
  });

  it.each(['{broken', JSON.stringify({ content: [[{ tag: 'text', text: 'unrelated' }]] }),
    JSON.stringify({ content: [[{ tag: 'text', text: '/fork task' }, { tag: 'a', href: 'javascript:alert(1)' }]] })])(
    'falls back to complete plain text for invalid or unsupported rich content', async raw => {
      const result = await prepareForkTopic('safe task\nnext line', { ...message('{}'), rawPostContent: raw }, deps());
      expect(result.content).toEqual([[{ tag: 'text', text: 'safe task' }], [{ tag: 'text', text: 'next line' }]]);
    });

  it('plain-text fallback strips uploaded image placeholders by ordinal while keeping file text and failed placeholders', async () => {
    // An inline file node (here on the first line) makes taskRows bail out →
    // the plain-text fallback path. taskText is taken from the real renderer
    // so `[文件 1: spec.pdf]` shares the first line and also exercises title
    // compression (the widened title placeholder regex).
    const post = { content: [
      [{ tag: 'text', text: '/fork 请分析这份资料' }, { tag: 'file', file_key: 'fk1', file_name: 'spec.pdf' }],
      [{ tag: 'img', image_key: 'ik1' }],
      [{ tag: 'img', image_key: 'ik2' }],
    ] };
    const msg = message(JSON.stringify(post));
    const taskText = msg.content.replace(/^\/fork\s*/i, '').trim();
    expect(taskText).toBe('请分析这份资料[文件 1: spec.pdf]\n[图片 1]\n[图片 2]');
    const io = deps();
    io.download.mockResolvedValue({ attachments: [
      { type: 'file' as const, name: 'spec.pdf', path: '/tmp/spec.pdf' },
      { type: 'image' as const, name: 'ik1.jpg', path: '/tmp/ik1.jpg' },
    ] });
    io.upload.mockResolvedValue('up1');
    const result = await prepareForkTopic(taskText, msg, io);
    const text = result.content.flatMap(row => row.filter(n => n.tag === 'text').map(n => n.text ?? '')).join('|');
    expect(text).not.toContain('[图片 1]');       // successful image placeholder removed
    expect(text).toContain('[图片 2]');           // failed image placeholder kept
    expect(text).toContain('[文件 1: spec.pdf]'); // file placeholder is never stripped from the body
    expect(result.content.flat().filter(n => n.tag === 'img')).toEqual([{ tag: 'img', image_key: 'up1' }]);
    expect(result.attachments.map(a => a.name).sort()).toEqual(['ik1.jpg', 'spec.pdf']);
    // Title compression must drop the suffixed file placeholder too (would
    // survive the narrow /\[(?:图片|文件)\s*\d+\]/ regex).
    expect(result.title).toBe('请分析这份资料');
  });

  it('plain-text fallback bounds ordinal matching so image 1 does not consume [图片 12]', async () => {
    const keys = Array.from({ length: 12 }, (_, i) => `ik${i + 1}`);
    const post = { content: [
      [{ tag: 'text', text: '/fork 汇总' }],
      ...keys.map(k => [{ tag: 'img', image_key: k }]),
      // Unsupported node forces the plain-text fallback even with all images present.
      [{ tag: 'code_block', language: 'ts', text: 'x' }],
    ] };
    const msg = message(JSON.stringify(post));
    const taskText = ['汇总', ...keys.map((_, i) => `[图片 ${i + 1}]`)].join('\n');
    const io = deps();
    io.download.mockResolvedValue({ attachments: [
      { type: 'image' as const, name: 'ik1.jpg', path: '/tmp/ik1.jpg' },
    ] });
    io.upload.mockResolvedValue('up1');
    const result = await prepareForkTopic(taskText, msg, io);
    const text = result.content.flatMap(row => row.filter(n => n.tag === 'text').map(n => n.text ?? '')).join('|');
    expect(text).not.toContain('[图片 1]');
    expect(text).toContain('[图片 12]');
    expect(text).toContain('[图片 2]');
    expect(result.content.flat().filter(n => n.tag === 'img')).toEqual([{ tag: 'img', image_key: 'up1' }]);
  });

  it('plain-text fallback strips every occurrence of a duplicated in-body image but appends one node', async () => {
    const post = { content: [
      [{ tag: 'text', text: '/fork 看图' }],
      // Same image_key twice collapses to one resource/ordinal, rendered as [图片 1] twice.
      [{ tag: 'img', image_key: 'ikdup' }],
      [{ tag: 'img', image_key: 'ikdup' }],
      [{ tag: 'code_block', language: 'ts', text: 'x' }],
    ] };
    const msg = message(JSON.stringify(post));
    const io = deps();
    io.download.mockResolvedValue({ attachments: [
      { type: 'image' as const, name: 'ikdup.jpg', path: '/tmp/ikdup.jpg' },
    ] });
    const result = await prepareForkTopic('看图\n[图片 1]\n[图片 1]', msg, io);
    const text = result.content.flatMap(row => row.filter(n => n.tag === 'text').map(n => n.text ?? '')).join('|');
    expect(text).not.toContain('[图片 1]');
    expect(result.content.flat().filter(n => n.tag === 'img'))
      .toEqual([{ tag: 'img', image_key: 'img_owned_by_bot' }]);
    expect(result.title).toBe('看图');
  });
});
