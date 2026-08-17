// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { TranscriptStore } from "@jarvis-viz/core";
import { TranscriptView } from "./transcript-view.js";

describe("TranscriptView", () => {
  let root: Root | undefined;
  afterEach(() => { if (root) act(() => root?.unmount()); root = undefined; });

  it("renders streamed messages and an accessible live region", () => {
    const store = new TranscriptStore();
    const mount = document.createElement("div");
    document.body.append(mount);
    root = createRoot(mount);
    act(() => root?.render(<TranscriptView store={store} />));
    act(() => { store.appendMessage("user", "Can you hear me?"); store.appendDelta("agent", "Loud and clear"); });
    expect(mount.textContent).toContain("Can you hear me?");
    expect(mount.textContent).toContain("Loud and clear");
    expect(mount.querySelector('[aria-live="polite"]')?.textContent).toContain("Agent");
    const announcement = mount.querySelector('[aria-live="polite"]')?.textContent;
    act(() => store.appendMessage("user", "A follow-up"));
    expect(mount.querySelector('[aria-live="polite"]')?.textContent).toBe(announcement);
    mount.remove();
  });

  it("keeps the mounted DOM bounded for long transcripts", () => {
    const store = new TranscriptStore();
    for (let index = 0; index < 1_000; index += 1) store.appendMessage(index % 2 === 0 ? "user" : "agent", `Message ${index}`, index);
    const mount = document.createElement("div");
    document.body.append(mount);
    root = createRoot(mount);
    act(() => root?.render(<TranscriptView store={store} height={280} rowHeight={56} />));
    expect(mount.querySelectorAll("article").length).toBeLessThan(20);
    expect(mount.textContent).toContain("Message 999");
    mount.remove();
  });

  it("stays pinned to new messages until the reader scrolls away", () => {
    const store = new TranscriptStore();
    for (let index = 0; index < 20; index += 1) store.appendMessage("agent", `Message ${index}`, index);
    const mount = document.createElement("div");
    document.body.append(mount);
    root = createRoot(mount);
    act(() => root?.render(<TranscriptView store={store} height={120} rowHeight={40} />));
    const viewport = mount.querySelector('[aria-label="Transcript messages"]') as HTMLDivElement;
    expect(viewport.scrollTop).toBe(680);

    act(() => store.appendMessage("agent", "Message 20", 20));
    expect(viewport.scrollTop).toBe(720);

    act(() => {
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    act(() => store.appendMessage("agent", "Message 21", 21));
    expect(viewport.scrollTop).toBe(0);
    mount.remove();
  });
});
