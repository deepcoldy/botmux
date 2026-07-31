import { describe, expect, it, vi } from "vitest";

import {
  compactGroupsMatrix,
  createGroupsMatrixSnapshot,
  enrichSessionsWithGroupNames,
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
