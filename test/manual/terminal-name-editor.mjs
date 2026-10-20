// Run: node test/manual/terminal-name-editor.mjs (requires Playwright Chromium).
// Isolated production component; no daemon/API calls or native OS IME coverage.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("../../", import.meta.url)).replace(
  /\/$/,
  "",
);
const require = createRequire(root + "/package.json");
const { build } = require("esbuild");
const { chromium } = require("playwright");
const bundle = await build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {TerminalNameEditor} from './src/dashboard/web/sessions-page'; function App(){ const [row,setRow]=React.useState({title:'before',sessionId:'demo'});return <><h2>Terminal title editing — isolated component</h2><div className="term-modal-head"><TerminalNameEditor row={row} onRename={(row,title)=>{window.saves.push(title);setRow({...row,title})}}/></div><button id="outside">Move focus</button><p>Real Chromium · fixture data · no live session</p></>}; window.saves=[];createRoot(document.getElementById('root')).render(<App/>);`,
    resolveDir: root,
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
});
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 480 },
  });
  await page.setContent(
    '<html><head></head><body><div id="root"></div></body></html>',
  );
  await page.addStyleTag({
    content:
      readFileSync(root + "/src/dashboard/web/style.css", "utf8") +
      "body{padding:40px;font-family:Arial;background:#161b22;color:#eee}.term-modal-head{padding:24px;margin:24px 0;border:1px solid #555}",
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const input = page.locator("input");
  await page.locator("#term-modal-edit").click();
  assert.deepEqual(
    await input.evaluate((e) => [e.selectionStart, e.selectionEnd]),
    [0, 6],
  );
  const width = await input.evaluate((e) => e.getBoundingClientRect().width);
  await input.press("End");
  await input.pressSequentially("abc");
  assert.equal(await input.inputValue(), "beforeabc");
  await input.fill("a much longer terminal title for width verification");
  assert.ok(
    (await input.evaluate((e) => e.getBoundingClientRect().width)) > width,
  );
  await input.fill("beforeabc");
  await input.evaluate((e) => e.setSelectionRange(6, 8));
  await page.keyboard.type("X");
  assert.equal(await input.inputValue(), "beforeXc");
  await input.press("Backspace");
  assert.equal(await input.inputValue(), "beforec");
  await input.press("Enter");
  assert.deepEqual(await page.evaluate(() => window.saves), ["beforec"]);
  await page.locator("#term-modal-edit").click();
  await input.fill("blur saved");
  await page.locator("#outside").click();
  assert.deepEqual(await page.evaluate(() => window.saves), [
    "beforec",
    "blur saved",
  ]);
  await page.locator("#term-modal-edit").click();
  await input.fill("cancelled");
  await input.press("Escape");
  assert.deepEqual(await page.evaluate(() => window.saves), [
    "beforec",
    "blur saved",
  ]);
  await page.locator("#term-modal-edit").click();
  assert.equal(await input.inputValue(), "blur saved");
  await input.fill("");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", {
    text: "中文",
    selectionStart: 2,
    selectionEnd: 2,
  });
  assert.equal(await input.inputValue(), "中文");
  await cdp.send("Input.insertText", { text: "中文" });
  await input.pressSequentially("abc");
  assert.equal(await input.inputValue(), "中文abc");
  mkdirSync(root + "/docs/assets/issue-2018", { recursive: true });
  await page.screenshot({
    path: root + "/docs/assets/issue-2018/terminal-name-edit.png",
  });
  await input.press("Enter");
  assert.equal((await page.evaluate(() => window.saves)).at(-1), "中文abc");
  console.log(
    "PASS: Chromium " +
      browser.version() +
      ": selection, typing, cursor/selection replacement, Backspace, width, Enter, blur, Escape, re-entry, CDP Chinese composition/commit. Native OS IME and live Dashboard not tested.",
  );
} finally {
  await browser.close();
}
