import { describe, expect, it } from 'vitest';
import { renderGroupNameAvatar } from '../src/services/group-name-avatar.js';
describe('group name avatar', () => {
  it.each(['项目讨论', 'Project Review', '长项目名称'.repeat(10), '🧑🏽‍💻开发讨论🚀'])('renders a bounded 360px PNG: %s', async name => {
    const png = await renderGroupNameAvatar(name);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBe(360);
    expect(png.readUInt32BE(20)).toBe(360);
  });
  it('rejects empty and overlong names', async () => {
    await expect(renderGroupNameAvatar('')).rejects.toThrow();
    await expect(renderGroupNameAvatar('a'.repeat(52))).rejects.toThrow();
  });
});
