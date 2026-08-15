import { describe, expect, it, vi } from "vitest";

import {
  compactGroupsMatrix,
  createGroupsMatrixSnapshot,
  dashboardEventInvalidatesGroupsMatrix,
  enrichSessionsWithGroupNames,
  roleWriteShouldInvalidate,
  type GroupsMatrix,
} from "../src/dashboard/groups-matrix-snapshot.js";

function matrix(name = "Release room"): GroupsMatrix {
  return {
    chats: [
      {
        chatId: "oc_release",
        name,
        avatar: "https://example.com/release.png",
        ownerId: "ou_owner",
        memberBots: [{ larkAppId: "cli_a", inChat: true }],
      },
    ],
    bots: [{ larkAppId: "cli_a", botName: "Codex" }],
  };
}

describe("groups matrix snapshot", () => {
  it("invalidates for daemon reply-policy changes only", () => {
    expect(dashboardEventInvalidatesGroupsMatrix({ type: "groups.reply-policy.changed" })).toBe(true);
    expect(dashboardEventInvalidatesGroupsMatrix({ type: "heartbeat" })).toBe(false);
  });

  it("coalesces concurrent builds and reuses the value within the TTL", async () => {
    let resolveBuild!: (value: GroupsMatrix) => void;
    const build = vi.fn(
      () =>
        new Promise<GroupsMatrix>((resolve) => {
          resolveBuild = resolve;
        }),
    );
    const snapshot = createGroupsMatrixSnapshot(build);

    const first = snapshot.get();
    const second = snapshot.get();
    expect(build).toHaveBeenCalledTimes(1);
    resolveBuild(matrix());
    await expect(Promise.all([first, second])).resolves.toEqual([matrix(), matrix()]);
    await snapshot.get();
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("refreshes after invalidation and when force is requested", async () => {
    const build = vi
      .fn()
      .mockResolvedValueOnce(matrix("First"))
      .mockResolvedValueOnce(matrix("Second"))
      .mockResolvedValueOnce(matrix("Third"));
    const snapshot = createGroupsMatrixSnapshot(build);

    await snapshot.get();
    snapshot.invalidate();
    await expect(snapshot.get()).resolves.toEqual(matrix("Second"));
    await expect(snapshot.get({ force: true })).resolves.toEqual(matrix("Third"));
    expect(build).toHaveBeenCalledTimes(3);
  });

  it("serves the last successful snapshot when a refresh fails", async () => {
    const onRefreshError = vi.fn();
    const build = vi
      .fn()
      .mockResolvedValueOnce(matrix())
      .mockRejectedValueOnce(new Error("daemon unavailable"));
    const snapshot = createGroupsMatrixSnapshot(build, { onRefreshError });

    await snapshot.get();
    snapshot.invalidate();
    await expect(snapshot.get()).resolves.toEqual(matrix());
    expect(onRefreshError).toHaveBeenCalledOnce();
  });
});

describe("groups presentation projection", () => {
  it("returns only the chat presentation allowlist", () => {
    expect(compactGroupsMatrix(matrix())).toEqual({
      chats: [
        {
          chatId: "oc_release",
          name: "Release room",
          avatar: "https://example.com/release.png",
        },
      ],
    });
  });

  it("fills missing group names without changing p2p or existing names", () => {
    const presentation = new Map([
      ["oc_release", { chatId: "oc_release", name: "Release room" }],
      ["oc_dm", { chatId: "oc_dm", name: "Wrong p2p name" }],
    ]);
    const sessions = enrichSessionsWithGroupNames(
      [
        { sessionId: "g1", chatId: "oc_release", chatType: "group" },
        {
          sessionId: "g2",
          chatId: "oc_release",
          chatType: "group",
          chatDisplayName: "Pinned name",
        },
        { sessionId: "p1", chatId: "oc_dm", chatType: "p2p", chatDisplayName: "Alice" },
      ],
      presentation,
    );

    expect(sessions).toEqual([
      { sessionId: "g1", chatId: "oc_release", chatType: "group", chatDisplayName: "Release room" },
      { sessionId: "g2", chatId: "oc_release", chatType: "group", chatDisplayName: "Pinned name" },
      { sessionId: "p1", chatId: "oc_dm", chatType: "p2p", chatDisplayName: "Alice" },
    ]);
  });
});

describe("roleWriteShouldInvalidate", () => {
  // ── invalidate: a role file was actually written / deleted ──────────────
  it("invalidates when the daemon reports a real role-file write (changed:true)", () => {
    // PUT with content → {ok:true,changed:true}; DELETE that removed a file →
    // {ok:true,existed:true,changed:true}; apply real write → {ok:true,changed:true}.
    expect(roleWriteShouldInvalidate(true, { ok: true, changed: true })).toBe(true);
    expect(roleWriteShouldInvalidate(true, { ok: true, existed: true, changed: true })).toBe(true);
    expect(roleWriteShouldInvalidate(true, { ok: true, changed: true, byteLength: 42 })).toBe(true);
  });

  it("invalidates a success that omits `changed` (fail-safe: refresh when unsure)", () => {
    // A proxied text body we can't introspect, or any writer that doesn't emit
    // `changed`, should still refresh the badge rather than leave it stale.
    expect(roleWriteShouldInvalidate(true, { ok: true })).toBe(true);
    expect(roleWriteShouldInvalidate(true, "OK")).toBe(true);
    expect(roleWriteShouldInvalidate(true, null)).toBe(true);
  });

  // ── do NOT invalidate: nothing changed → busting the cache would just
  //    punch through the 30s snapshot on a common no-op ─────────────────────
  it("does not invalidate an injectMode-only PUT (changed:false, hasRole untouched)", () => {
    // saveInjectMode() sends {injectMode} with no content → daemon writes only
    // the .meta.json sidecar and reports changed:false.
    expect(roleWriteShouldInvalidate(true, { ok: true, changed: false })).toBe(false);
  });

  it("does not invalidate a DELETE that removed nothing (existed/changed:false)", () => {
    expect(roleWriteShouldInvalidate(true, { ok: true, existed: false, changed: false })).toBe(false);
  });

  it("does not invalidate on apply preview (ok:true but changed:false)", () => {
    expect(
      roleWriteShouldInvalidate(true, { ok: true, preview: true, changed: false, wouldOverwrite: true }),
    ).toBe(false);
  });

  it("does not invalidate when apply is a no-op / missing entry (changed:false)", () => {
    expect(roleWriteShouldInvalidate(true, { ok: false, error: "missing_entry", changed: false })).toBe(false);
  });

  it("does not invalidate on an application-level failure (ok:false)", () => {
    expect(roleWriteShouldInvalidate(true, { ok: false, error: "content_required" })).toBe(false);
  });

  it("does not invalidate when the HTTP call failed (e.g. 409 chat_role_exists / 500)", () => {
    // upstream.ok is false for 4xx/5xx — never invalidate regardless of body.
    expect(roleWriteShouldInvalidate(false, { ok: false, error: "chat_role_exists" })).toBe(false);
    expect(roleWriteShouldInvalidate(false, { ok: true, changed: true })).toBe(false);
  });
});
