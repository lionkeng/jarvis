import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilityRegistryError, DuplicateCapabilityError, VoiceRegistry } from "./registry.js";
import type { VoiceCapability, VoiceControl, VoiceOutcome } from "./types.js";

const navigation: VoiceControl = {
  kind: "pick",
  id: "navigation",
  what: "Go to a page of the app",
  items: [
    { id: "dashboard", spoken: "the dashboard page" },
    { id: "library", spoken: "the library page" },
  ],
};

const content: VoiceControl = {
  kind: "adjust",
  id: "article.content",
  what: "Scroll the article text",
  axes: [{ id: "vertical", more: "down", less: "up" }],
};

function capability(
  control: VoiceControl,
  execute: VoiceCapability["execute"] = async () => ({ status: "done" }) as VoiceOutcome,
  facts?: Record<string, string>,
): VoiceCapability {
  return {
    describe: () => (facts ? { control, facts } : { control }),
    execute,
  };
}

describe("VoiceRegistry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("describes every registered control and merges their facts", () => {
    const registry = new VoiceRegistry();
    registry.register(capability(navigation, undefined, { page: "article" }));
    registry.register(capability(content, undefined, { bookmarked: "no" }));
    expect(registry.describe()).toEqual({
      controls: [navigation, content],
      facts: { page: "article", bookmarked: "no" },
    });
  });

  it("rejects a second capability with the same control id", () => {
    const registry = new VoiceRegistry();
    registry.register(capability(navigation));
    expect(() => registry.register(capability(navigation))).toThrow(DuplicateCapabilityError);
  });

  it("drops the control when the registration is undone", () => {
    const registry = new VoiceRegistry();
    const undo = registry.register(capability(navigation));
    registry.register(capability(content));
    undo();
    expect(registry.describe().controls).toEqual([content]);
  });

  it("leaves a replacement in place when a stale unregister runs", () => {
    const registry = new VoiceRegistry();
    const undo = registry.register(capability(navigation));
    registry.unregister("navigation");
    const replacement = capability(navigation);
    registry.register(replacement);
    undo();
    expect(registry.describe().controls).toEqual([navigation]);
  });

  it("resolves waitFor at once for a registered control", async () => {
    const registry = new VoiceRegistry();
    const nav = capability(navigation);
    registry.register(nav);
    await expect(registry.waitFor("navigation", new AbortController().signal)).resolves.toBe(nav);
  });

  it("resolves a late registration before the timeout", async () => {
    vi.useFakeTimers();
    const registry = new VoiceRegistry();
    const pending = registry.waitFor("article.content", new AbortController().signal);
    const late = capability(content);
    await vi.advanceTimersByTimeAsync(500);
    registry.register(late);
    await expect(pending).resolves.toBe(late);
  });

  it("times out a control that never registers", async () => {
    vi.useFakeTimers();
    const registry = new VoiceRegistry();
    const pending = registry.waitFor("article.content", new AbortController().signal);
    const expectation = expect(pending).rejects.toMatchObject({
      name: "CapabilityRegistryError",
      code: "target_unavailable",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await expectation;
  });

  it("rejects a wait that is aborted while it runs", async () => {
    const registry = new VoiceRegistry();
    const controller = new AbortController();
    const pending = registry.waitFor("article.content", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });

  it("rejects a wait that starts with an aborted signal", async () => {
    const registry = new VoiceRegistry();
    const controller = new AbortController();
    controller.abort();
    await expect(registry.waitFor("navigation", controller.signal)).rejects.toBeInstanceOf(CapabilityRegistryError);
  });

  it("settles after one macrotask when nothing is pending", async () => {
    const registry = new VoiceRegistry();
    let settled = false;
    const pending = registry.settle(new AbortController().signal).then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    await pending;
    expect(settled).toBe(true);
  });

  it("sees every control that registers before it resolves", async () => {
    const registry = new VoiceRegistry();
    const seen: string[] = [];
    const pending = registry.settle(new AbortController().signal).then(() => {
      seen.push(...registry.describe().controls.map((control) => control.id));
    });
    registry.register(capability(navigation));
    await Promise.resolve();
    registry.register(capability(content));
    await pending;
    expect(seen).toEqual(["navigation", "article.content"]);
  });

  it("settles again after an unregister", async () => {
    const registry = new VoiceRegistry();
    const undo = registry.register(capability(navigation));
    const seen: string[] = [];
    const pending = registry.settle(new AbortController().signal).then(() => {
      seen.push(...registry.describe().controls.map((control) => control.id));
    });
    undo();
    await pending;
    expect(seen).toEqual([]);
  });

  it("rejects a settle that is aborted", async () => {
    const registry = new VoiceRegistry();
    const controller = new AbortController();
    const pending = registry.settle(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });

  it("runs a command through the capability that owns the control", async () => {
    const registry = new VoiceRegistry();
    const execute = vi.fn(async () => ({ status: "done", say: "Opened the library." }) as VoiceOutcome);
    registry.register(capability(navigation, execute));
    const command = { control: "navigation", kind: "pick", item: "library" } as const;
    await expect(registry.execute(command, new AbortController().signal)).resolves.toEqual({
      status: "done",
      say: "Opened the library.",
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects a command whose item is no longer on screen", async () => {
    const registry = new VoiceRegistry();
    const execute = vi.fn(async () => ({ status: "done" }) as VoiceOutcome);
    registry.register(capability({ ...navigation, items: [{ id: "dashboard", spoken: "the dashboard page" }] }, execute));
    await expect(
      registry.execute({ control: "navigation", kind: "pick", item: "library" }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "execution_failed" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a command whose axis is no longer on screen", async () => {
    const registry = new VoiceRegistry();
    registry.register(capability(content));
    await expect(
      registry.execute(
        { control: "article.content", kind: "adjust", axis: "horizontal", direction: "more", amount: 1 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "execution_failed" });
  });

  it("rejects a command whose kind no longer matches the control", async () => {
    const registry = new VoiceRegistry();
    registry.register(capability(navigation));
    await expect(
      registry.execute({ control: "navigation", kind: "press" }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "execution_failed" });
  });

  it("waits for a control to register before it executes", async () => {
    const registry = new VoiceRegistry();
    const execute = vi.fn(async () => ({ status: "done" }) as VoiceOutcome);
    const pending = registry.execute(
      { control: "article.content", kind: "adjust", axis: "vertical", direction: "more", amount: 2 },
      new AbortController().signal,
    );
    registry.register(capability(content, execute));
    await pending;
    expect(execute).toHaveBeenCalledOnce();
  });
});
