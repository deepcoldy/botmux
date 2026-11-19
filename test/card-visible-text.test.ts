import { describe, expect, it } from 'vitest';
import { buildRepoSelectCard } from '../src/im/lark/card-builder.js';
import { cardVisibleText } from './helpers/card-visible-text.js';

describe('missing-directory card visible path', () => {
  it.each(['/tmp/plain/repo', '/tmp/gone_dir/[repo]*', 'C:\\gone_dir\\repo'])('%s survives wire escaping', (path) => {
    const card = buildRepoSelectCard([], undefined, 'om_missing', 'zh', false, {
      missingPath: path, opening: true,
    });
    expect(cardVisibleText(card)).toContain(path);
  });
});
