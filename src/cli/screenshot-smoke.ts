import xtermHeadless from '@xterm/headless';
import { captureToPng } from '../utils/screenshot-renderer.js';

export async function runScreenshotSmoke(): Promise<Buffer> {
  const cols = 20;
  const rows = 2;
  const terminal = new xtermHeadless.Terminal({ cols, rows, allowProposedApi: true });
  try {
    await new Promise<void>((resolveWrite) => terminal.write('\x1b[31mPNG smoke\x1b[0m\r\nterminal screenshot', resolveWrite));
    return await captureToPng(terminal, { cols, rows, startY: 0 });
  } finally {
    terminal.dispose();
  }
}
