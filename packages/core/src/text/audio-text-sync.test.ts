import { describe, expect, it, vi } from "vitest";
import { AudioTextSynchronizer } from "./audio-text-sync.js";

describe("AudioTextSynchronizer", () => {
  it("holds generated text until audio is audible, then reveals it at speech pace", () => {
    const append = vi.fn();
    const sync = new AudioTextSynchronizer(append, {
      charactersPerSecond: 20,
      initialCharacterCredit: 6,
      silenceHoldMs: 500,
    });
    sync.enqueue("Hello there from the agent. ", 0);
    sync.finish(undefined, 20);

    sync.tick(100, false);
    expect(append).not.toHaveBeenCalled();

    expect(sync.tick(200, true)).toEqual({ audioStarted: true, completed: false });
    expect(append).toHaveBeenLastCalledWith("Hello ", 200);
    expect(append.mock.calls.flatMap(([text]) => text).join("")).toBe("Hello ");

    sync.tick(700, true);
    expect(append.mock.calls.flatMap(([text]) => text).join("")).toBe("Hello there ");
  });

  it("flushes the final tail only after locally observed playback becomes silent", () => {
    const append = vi.fn();
    const sync = new AudioTextSynchronizer(append, {
      charactersPerSecond: 12,
      initialCharacterCredit: 4,
      silenceHoldMs: 400,
    });
    sync.enqueue("One two three four", 10);
    sync.finish("One two three four", 20);

    sync.tick(100, true);
    sync.tick(500, true);
    expect(sync.tick(600, false).completed).toBe(false);
    expect(sync.tick(999, false).completed).toBe(false);
    expect(sync.tick(1_000, false).completed).toBe(true);
    expect(append.mock.calls.flatMap(([text]) => text).join("")).toBe("One two three four");
    expect(sync.active).toBe(false);
  });

  it("discards text that was never heard when the user interrupts", () => {
    const append = vi.fn();
    const sync = new AudioTextSynchronizer(append);
    sync.enqueue("This text has not played yet", 0);
    expect(sync.interrupt()).toBe(true);
    sync.tick(1_000, true);
    expect(append).not.toHaveBeenCalled();
    expect(sync.active).toBe(false);
  });

  it("falls back to the final transcript when an expected audio signal never arrives", () => {
    const append = vi.fn();
    const sync = new AudioTextSynchronizer(append, { startupTimeoutMs: 1_000 });
    sync.enqueue("Fallback transcript", 0);
    sync.finish(undefined, 10);
    expect(sync.tick(999, false).completed).toBe(false);
    expect(sync.tick(1_000, false).completed).toBe(true);
    expect(append).toHaveBeenCalledWith("Fallback transcript", 1_000);
  });

  it("scales transcript release with the selected speech-rate multiplier", () => {
    const append = vi.fn();
    const sync = new AudioTextSynchronizer(append, { charactersPerSecond: 10, initialCharacterCredit: 1 });
    sync.setRateMultiplier(2);
    sync.enqueue("one two three ", 10);
    sync.tick(100, true);
    sync.tick(350, true);
    expect(append.mock.calls.flatMap(([text]) => text).join("")).toBe("one ");
  });

  it("paces unspaced Chinese text by grapheme without dropping characters", () => {
    const append = vi.fn();
    const sync = new AudioTextSynchronizer(append, {
      charactersPerSecond: 6,
      initialCharacterCredit: 2,
      silenceHoldMs: 300,
    });
    const transcript = "你好，世界。这是普通话，也支持粤语。";
    sync.enqueue(transcript, 0);
    sync.finish(transcript, 10);

    sync.tick(100, true);
    expect(append.mock.calls.flatMap(([text]) => text).join("")).toBe("你好");
    sync.tick(600, true);
    const partial = append.mock.calls.flatMap(([text]) => text).join("");
    expect(partial.length).toBeGreaterThan(2);
    expect(transcript.startsWith(partial)).toBe(true);

    sync.tick(700, false);
    expect(sync.tick(1_000, false).completed).toBe(true);
    expect(append.mock.calls.flatMap(([text]) => text).join("")).toBe(transcript);
  });
});
