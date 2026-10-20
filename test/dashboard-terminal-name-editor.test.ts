import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TerminalNameEditor } from "../src/dashboard/web/sessions-page.js";

let renderer: TestRenderer.ReactTestRenderer;
let input: any;
const onRename = vi.fn();
const row = { title: "before", sessionId: "session-demo" };
const field = () => renderer.root.findByType("input");
async function start() {
  await act(async () =>
    renderer.root.findByProps({ id: "term-modal-edit" }).props.onClick(),
  );
}
async function replaceSelection(text: string) {
  input.value =
    input.value.slice(0, input.selectionStart) +
    text +
    input.value.slice(input.selectionEnd);
  input.selectionStart += text.length;
  input.selectionEnd = input.selectionStart;
  await act(async () => field().props.onChange({ currentTarget: input }));
}
async function key(key: string) {
  await act(async () =>
    field().props.onKeyDown({ key, stopPropagation() {}, preventDefault() {} }),
  );
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { innerWidth: 1000 });
  vi.stubGlobal("getComputedStyle", () => ({}));
  vi.stubGlobal("document", {
    body: { appendChild() {} },
    createElement: () => ({
      style: {},
      textContent: "",
      get offsetWidth() {
        return this.textContent.length * 10;
      },
      remove() {},
    }),
  });
  onRename.mockClear();
  input = {
    value: "",
    style: {},
    selectionStart: 0,
    selectionEnd: 0,
    focus: vi.fn(),
    select: vi.fn(() => {
      input.selectionStart = 0;
      input.selectionEnd = input.value.length;
    }),
  };
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(TerminalNameEditor, { row, onRename }),
      {
        createNodeMock(element) {
          if (element.type === "input") {
            input.value = element.props.value;
            return input;
          }
          return null;
        },
      },
    );
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});

it("selects only on entry, retaining cursor/selection edits while fitting the width", async () => {
  await start();
  expect(input.focus).toHaveBeenCalledOnce();
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 6]);
  const initialWidth = parseInt(input.style.width);
  input.selectionStart = input.selectionEnd = input.value.length;
  for (const character of "abc") await replaceSelection(character);
  expect(field().props.value).toBe("beforeabc");
  expect(input.select).toHaveBeenCalledOnce();
  expect(parseInt(input.style.width)).toBeGreaterThan(initialWidth);
  input.selectionStart = 6;
  input.selectionEnd = 8;
  await replaceSelection("X");
  expect(field().props.value).toBe("beforeXc");
  // Backspace removes the preceding character without resetting the caret.
  input.selectionStart--;
  await replaceSelection("");
  expect(field().props.value).toBe("beforec");
  expect(input.selectionStart).toBe(6);
  await key("Enter");
  expect(onRename).toHaveBeenCalledExactlyOnceWith(row, "beforec");
  await start();
  expect(input.select).toHaveBeenCalledTimes(2);
});

it("saves on blur, cancels on Escape, and ignores empty or unchanged titles", async () => {
  await start();
  await replaceSelection("  renamed  ");
  await act(async () => field().props.onBlur());
  expect(onRename).toHaveBeenCalledExactlyOnceWith(row, "renamed");
  onRename.mockClear();
  await start();
  await replaceSelection("cancelled");
  await key("Escape");
  expect(onRename).not.toHaveBeenCalled();
  await start();
  expect(field().props.value).toBe("before");
  expect(field().props.maxLength).toBe(200);
  await key("Enter");
  await start();
  await replaceSelection("  ");
  await key("Enter");
  expect(onRename).not.toHaveBeenCalled();
});
