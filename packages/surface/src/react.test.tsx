// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceCapability } from "./react.js";
import { VoiceRegistry } from "./registry.js";
import type { VoiceCapability, VoiceOutcome } from "./types.js";

function Bookmark({ registry, id }: { registry: VoiceRegistry; id: string }): null {
  const [on, setOn] = useState(false);
  const capability: VoiceCapability = {
    describe: () => ({
      control: {
        kind: "toggle",
        id,
        what: "Add or remove the bookmark on this article",
        items: [{ id: "bookmark", spoken: "the bookmark on this article", on }],
      },
      facts: { bookmarked: on ? "yes" : "no" },
    }),
    execute: async (command): Promise<VoiceOutcome> => {
      setOn(command.kind === "toggle" && command.to === "on");
      return { status: "done", say: "Bookmarked." };
    },
  };
  useVoiceCapability(registry, capability);
  return null;
}

describe("useVoiceCapability", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  it("registers the control while the component is mounted", () => {
    const registry = new VoiceRegistry();
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Bookmark, { registry, id: "article.bookmark" })));
    expect(registry.describe().controls.map((control) => control.id)).toEqual(["article.bookmark"]);
    act(() => root.unmount());
    expect(registry.describe().controls).toEqual([]);
  });

  it("describes the current React state without registering a second time", async () => {
    const registry = new VoiceRegistry();
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Bookmark, { registry, id: "article.bookmark" })));
    expect(registry.describe().facts).toEqual({ bookmarked: "no" });
    await act(async () => {
      await registry.execute(
        { control: "article.bookmark", kind: "toggle", item: "bookmark", to: "on" },
        new AbortController().signal,
      );
    });
    expect(registry.describe().facts).toEqual({ bookmarked: "yes" });
    expect(registry.describe().controls).toHaveLength(1);
    act(() => root.unmount());
  });

  it("registers again under a new id when the control id changes", () => {
    const registry = new VoiceRegistry();
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Bookmark, { registry, id: "article.bookmark" })));
    act(() => root.render(createElement(Bookmark, { registry, id: "library.bookmark" })));
    expect(registry.describe().controls.map((control) => control.id)).toEqual(["library.bookmark"]);
    act(() => root.unmount());
    expect(registry.describe().controls).toEqual([]);
  });

  it("lets two components hold two controls at once", () => {
    const registry = new VoiceRegistry();
    const first = createRoot(document.createElement("div"));
    const second = createRoot(document.createElement("div"));
    act(() => first.render(createElement(Bookmark, { registry, id: "article.bookmark" })));
    act(() => second.render(createElement(Bookmark, { registry, id: "library.bookmark" })));
    expect(registry.describe().controls.map((control) => control.id)).toEqual([
      "article.bookmark",
      "library.bookmark",
    ]);
    act(() => first.unmount());
    expect(registry.describe().controls.map((control) => control.id)).toEqual(["library.bookmark"]);
    act(() => second.unmount());
  });
});
