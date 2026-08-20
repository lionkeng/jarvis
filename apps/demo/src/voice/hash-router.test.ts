// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHashRouter, parseRouteHash } from "./hash-router.js";

describe("parseRouteHash", () => {
  it("maps the four app hashes", () => {
    expect(parseRouteHash("#/dashboard")).toBe("dashboard");
    expect(parseRouteHash("#/library")).toBe("library");
    expect(parseRouteHash("#/article")).toBe("article");
    expect(parseRouteHash("#/settings")).toBe("settings");
  });

  it("falls back to dashboard for empty and unknown hashes", () => {
    expect(parseRouteHash("")).toBe("dashboard");
    expect(parseRouteHash("#")).toBe("dashboard");
    expect(parseRouteHash("#/")).toBe("dashboard");
    expect(parseRouteHash("#/admin")).toBe("dashboard");
    expect(parseRouteHash("#mystery")).toBe("dashboard");
  });
});

describe("createHashRouter", () => {
  let router: ReturnType<typeof createHashRouter>;

  beforeEach(() => {
    window.location.hash = "";
    router = createHashRouter();
  });

  afterEach(() => {
    router.dispose();
    window.location.hash = "";
  });

  it("reads the current hash snapshot", async () => {
    expect(router.getSnapshot()).toBe("dashboard");
    await router.navigate("library");
    expect(router.getSnapshot()).toBe("library");
    expect(window.location.hash).toBe("#/library");
  });

  it("notifies subscribers on hash updates", async () => {
    const listener = vi.fn();
    const unsubscribe = router.subscribe(listener);
    await router.navigate("article");
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it("stops notifying after unsubscribe", async () => {
    const listener = vi.fn();
    const unsubscribe = router.subscribe(listener);
    unsubscribe();
    await router.navigate("settings");
    expect(listener).not.toHaveBeenCalled();
  });

  it("resolves navigate only after the snapshot matches", async () => {
    const seen: string[] = [];
    const pending = router.navigate("settings").then(() => {
      seen.push(router.getSnapshot());
    });
    await pending;
    expect(seen).toEqual(["settings"]);
  });

  it("resolves repeated navigation to the current route", async () => {
    await router.navigate("library");
    await expect(router.navigate("library")).resolves.toBeUndefined();
    expect(router.getSnapshot()).toBe("library");
  });

  it("falls back without throwing when the hash is unknown", () => {
    window.location.hash = "#/not-a-page";
    expect(router.getSnapshot()).toBe("dashboard");
  });
});
