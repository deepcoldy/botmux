import { describe, it, expect } from 'vitest';
import { weixinCardBuilder } from '../card-builder.js';

describe('weixinCardBuilder', () => {
  describe('buildSessionCard', () => {
    it('includes terminal URL in output', () => {
      const card = weixinCardBuilder.buildSessionCard({
        sessionId: 'sess-1',
        rootMessageId: 'root-1',
        terminalUrl: 'https://terminal.example.com/s/123',
        title: 'My Session',
      });
      const text = card.payload as string;
      expect(text).toContain('https://terminal.example.com/s/123');
    });

    it('includes session title', () => {
      const card = weixinCardBuilder.buildSessionCard({
        sessionId: 's',
        rootMessageId: 'r',
        terminalUrl: 'https://t.co',
        title: 'Test Title',
      });
      const text = card.payload as string;
      expect(text).toContain('Test Title');
    });

    it('includes help instruction', () => {
      const card = weixinCardBuilder.buildSessionCard({
        sessionId: 's',
        rootMessageId: 'r',
        terminalUrl: 'u',
        title: 't',
      });
      const text = card.payload as string;
      expect(text).toContain('/help');
    });
  });

  describe('buildStreamingCard', () => {
    it('shows idle icon and includes content preview when idle', () => {
      const card = weixinCardBuilder.buildStreamingCard({
        sessionId: 's',
        rootMessageId: 'r',
        terminalUrl: 'https://t.co',
        title: 'Task Done',
        content: 'Final output here',
        status: 'idle',
      });
      const text = card.payload as string;
      expect(text).toContain('Task Done');
      expect(text).toContain('Final output here');
    });

    it('shows working icon for working status without content preview', () => {
      const card = weixinCardBuilder.buildStreamingCard({
        sessionId: 's',
        rootMessageId: 'r',
        terminalUrl: 'https://t.co',
        title: 'Working',
        content: 'some output',
        status: 'working',
      });
      const text = card.payload as string;
      expect(text).toContain('Working');
      // Working status should not include content preview
      expect(text).not.toContain('some output');
    });

    it('shows starting icon for starting status', () => {
      const card = weixinCardBuilder.buildStreamingCard({
        sessionId: 's',
        rootMessageId: 'r',
        terminalUrl: 'u',
        title: 'Starting',
        content: '',
        status: 'starting',
      });
      const text = card.payload as string;
      expect(text).toContain('Starting');
    });

    it('truncates long content to 800 chars from the end', () => {
      const longContent = 'x'.repeat(1000);
      const card = weixinCardBuilder.buildStreamingCard({
        sessionId: 's',
        rootMessageId: 'r',
        terminalUrl: 'u',
        title: 't',
        content: longContent,
        status: 'idle',
      });
      const text = card.payload as string;
      // The preview should be the last 800 chars
      expect(text).toContain('x'.repeat(800));
      // Full 1000 chars should not appear
      expect(text).not.toContain('x'.repeat(1000));
    });

    it('includes terminal URL', () => {
      const card = weixinCardBuilder.buildStreamingCard({
        sessionId: 's',
        rootMessageId: 'r',
        terminalUrl: 'https://my-terminal.com',
        title: 't',
        content: '',
        status: 'working',
      });
      const text = card.payload as string;
      expect(text).toContain('https://my-terminal.com');
    });
  });

  describe('buildRepoSelectCard', () => {
    it('lists projects with numbers', () => {
      const card = weixinCardBuilder.buildRepoSelectCard({
        projects: [
          { name: 'alpha', path: '/home/alpha', description: 'd1' },
          { name: 'beta', path: '/home/beta', description: 'd2' },
        ],
        currentCwd: '/home/alpha',
        rootMessageId: 'r',
      });
      const text = card.payload as string;
      expect(text).toContain('1. alpha (/home/alpha)');
      expect(text).toContain('2. beta (/home/beta)');
    });

    it('includes skip instruction with current cwd', () => {
      const card = weixinCardBuilder.buildRepoSelectCard({
        projects: [{ name: 'p', path: '/p', description: '' }],
        currentCwd: '/my/cwd',
        rootMessageId: 'r',
      });
      const text = card.payload as string;
      expect(text).toContain('/skip');
      expect(text).toContain('/my/cwd');
    });
  });
});
