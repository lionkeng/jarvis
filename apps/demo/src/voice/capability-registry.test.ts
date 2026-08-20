// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CapabilityRegistryError,
  DuplicateCapabilityError,
  NAVIGATION_CAPABILITY_ID,
  UiCapabilityRegistry,
  useUiCapability,
  type UiCapability,
} from "./capability-registry.js";
import type { UiCommand } from "./interaction-contract.js";

function capability(actions: UiCommand["type"][], execute: UiCapability["execute"] = async () => undefined): UiCapability {
  return { supportedActions: actions, execute };
}

describe("UiCapabilityRegistry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves waitFor immediately when the target is already registered", async () => {
    const registry = new UiCapabilityRegistry();
    const nav = capability(["navigate"]);
    registry.register(NAVIGATION_CAPABILITY_ID, nav);
    await expect(registry.waitFor(NAVIGATION_CAPABILITY_ID, new AbortController().signal)).resolves.toBe(nav);
  });

  it("resolves a late registration before the timeout", async () => {
    vi.useFakeTimers();
    const registry = new UiCapabilityRegistry();
    const pending = registry.waitFor("article.content", new AbortController().signal);
    const scroll = capability(["scroll"]);
    await vi.advanceTimersByTimeAsync(500);
    registry.register("article.content", scroll);
    await expect(pending).resolves.toBe(scroll);
  });

  it("executes in order after a route change unregisters and re-registers a target", async () => {
    const registry = new UiCapabilityRegistry();
    const order: string[] = [];
    registry.register(NAVIGATION_CAPABILITY_ID, capability(["navigate"], async () => {
      order.push("navigate");
      registry.unregister("library.results");
    }));
    registry.register("library.results", capability(["scroll"], async () => {
      order.push("stale-scroll");
    }));
    await registry.execute({ type: "navigate", route: "article" }, new AbortController().signal);
    const scroll = registry.execute(
      { type: "scroll", target: "article.content", direction: "bottom" },
      new AbortController().signal,
    );
    registry.register("article.content", capability(["scroll"], async () => {
      order.push("article-scroll");
    }));
    await scroll;
    expect(order).toEqual(["navigate", "article-scroll"]);
  });

  it("times out when a target never registers", async () => {
    vi.useFakeTimers();
    const registry = new UiCapabilityRegistry();
    const pending = registry.waitFor("article.content", new AbortController().signal);
    const expectation = expect(pending).rejects.toMatchObject({
      name: "CapabilityRegistryError",
      code: "target_unavailable",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await expectation;
  });

  it("rejects an aborted wait", async () => {
    const registry = new UiCapabilityRegistry();
    const controller = new AbortController();
    const pending = registry.waitFor("article.content", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });

  it("rejects a wait that starts with an already aborted signal", async () => {
    const registry = new UiCapabilityRegistry();
    const controller = new AbortController();
    controller.abort();
    await expect(registry.waitFor("article.content", controller.signal)).rejects.toMatchObject({ code: "cancelled" });
  });

  it("unregisters a target so a later wait has to wait again", async () => {
    vi.useFakeTimers();
    const registry = new UiCapabilityRegistry();
    registry.register("dashboard.search", capability(["focus"]));
    registry.unregister("dashboard.search");
    const pending = registry.waitFor("dashboard.search", new AbortController().signal);
    const expectation = expect(pending).rejects.toBeInstanceOf(CapabilityRegistryError);
    await vi.advanceTimersByTimeAsync(2_000);
    await expectation;
  });

  it("rejects duplicate registrations", () => {
    const registry = new UiCapabilityRegistry();
    registry.register("library.item", capability(["select"]));
    expect(() => registry.register("library.item", capability(["select"]))).toThrow(DuplicateCapabilityError);
  });

  it("rejects unsupported actions after the target is ready", async () => {
    const registry = new UiCapabilityRegistry();
    registry.register("library.details", capability(["open"]));
    await expect(registry.execute({ type: "close", target: "library.details" }, new AbortController().signal)).rejects.toMatchObject({
      code: "execution_failed",
    });
  });

  it("allows register after unregister of the same id", async () => {
    const registry = new UiCapabilityRegistry();
    const first = capability(["focus"]);
    const second = capability(["focus"]);
    registry.register("dashboard.search", first);
    registry.unregister("dashboard.search");
    registry.register("dashboard.search", second);
    await expect(registry.waitFor("dashboard.search", new AbortController().signal)).resolves.toBe(second);
  });
});

describe("useUiCapability", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers in useLayoutEffect and unregisters on cleanup", async () => {
    const registry = new UiCapabilityRegistry();
    const host = document.createElement("div");
    const root = createRoot(host);
    function Probe() {
      useUiCapability(registry, "dashboard.search", capability(["focus"]));
      return null;
    }
    await act(() => root.render(createElement(Probe)));
    await expect(registry.waitFor("dashboard.search", new AbortController().signal)).resolves.toMatchObject({
      supportedActions: ["focus"],
    });
    await act(() => root.unmount());
    vi.useFakeTimers();
    const pending = registry.waitFor("dashboard.search", new AbortController().signal);
    const expectation = expect(pending).rejects.toMatchObject({ code: "target_unavailable" });
    await vi.advanceTimersByTimeAsync(2_000);
    await expectation;
    vi.useRealTimers();
  });
});
