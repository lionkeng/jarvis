import { afterEach, describe, expect, it, vi } from "vitest";
import { PcmDuplex } from "./pcm-duplex.js";

afterEach(() => { vi.unstubAllGlobals(); });

class FakeBuffer {
  readonly #channel: Float32Array;
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    this.#channel = new Float32Array(length);
  }
  get duration(): number { return this.length / this.sampleRate; }
  getChannelData(): Float32Array { return this.#channel; }
}

class FakeNode {
  readonly targets: unknown[] = [];
  connect = vi.fn((target: unknown) => { this.targets.push(target); });
  disconnect = vi.fn();
}

class FakeSource extends FakeNode {
  buffer: FakeBuffer | undefined;
  onended: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
}

class FakeWorklet extends FakeNode {
  readonly port = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: vi.fn() };
  constructor(readonly context: FakeContext, readonly name: string) { super(); }
}

class FakeContext {
  static readonly instances: FakeContext[] = [];
  currentTime = 0;
  state = "suspended";
  readonly destination = { kind: "speakers" };
  readonly nodes: FakeNode[] = [];
  readonly sources: FakeSource[] = [];
  readonly modules: string[] = [];
  readonly agentTrack = { kind: "audio", stop: vi.fn() };
  readonly sink = { stream: { getAudioTracks: () => [this.agentTrack] }, ...new FakeNode() };
  readonly audioWorklet = { addModule: vi.fn(async (url: string) => { this.modules.push(url); }) };
  readonly sampleRate: number;
  readonly pinned: boolean;
  resume = vi.fn(async () => { this.state = "running"; });
  close = vi.fn(async () => { this.state = "closed"; });
  createMediaStreamSource = vi.fn(() => this.#track(new FakeNode()));
  createMediaStreamDestination = vi.fn(() => this.sink);
  createBuffer = vi.fn((channels: number, length: number, rate: number) => new FakeBuffer(channels, length, rate));
  createBufferSource = vi.fn(() => { const source = this.#track(new FakeSource()); this.sources.push(source); return source; });
  constructor(options: { sampleRate?: number } = {}) {
    this.pinned = options.sampleRate !== undefined;
    this.sampleRate = options.sampleRate ?? 48_000;
    FakeContext.instances.push(this);
  }
  #track<T extends FakeNode>(node: T): T { this.nodes.push(node); return node; }
}

function stubAudio() {
  FakeContext.instances.length = 0;
  const microphoneTrack = { kind: "audio", stop: vi.fn() };
  const microphone = { getTracks: () => [microphoneTrack] };
  const getUserMedia = vi.fn(async () => microphone);
  const worklets: FakeWorklet[] = [];
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("AudioWorkletNode", class extends FakeWorklet {
    constructor(context: FakeContext, name: string) { super(context, name); worklets.push(this); }
  });
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn(() => "blob:jarvis-pcm");
    static revokeObjectURL = vi.fn();
  });
  const captured: Array<{ pcm16: ArrayBuffer; rate: number }> = [];
  const duplex = new PcmDuplex({ capture: (pcm16, rate) => captured.push({ pcm16, rate }) });
  return {
    duplex, getUserMedia, microphoneTrack, captured, worklets,
    playback: () => FakeContext.instances[0]!,
    capture: () => FakeContext.instances.at(-1)!,
  };
}

function pcm(...samples: number[]): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(samples.length * 2));
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return view.buffer;
}

describe("PCM duplex", () => {
  it("captures echo-cancelled microphone audio at the PCM rate", async () => {
    const h = stubAudio();
    await h.duplex.start();
    expect(h.getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    expect(h.capture().sampleRate).toBe(16_000);
    expect(h.capture().modules).toEqual(["blob:jarvis-pcm"]);
    expect(h.worklets[0]!.name).toBe("jarvis-pcm-capture");
    h.worklets[0]!.port.onmessage!({ data: Float32Array.of(0, 1, -1) });
    expect(h.captured).toHaveLength(1);
    expect(h.captured[0]!.rate).toBe(16_000);
    expect([...new Int16Array(h.captured[0]!.pcm16)]).toEqual([0, 32_767, -32_768]);
    await h.duplex.close();
  });

  it("reports the real capture rate when the context refuses 16 kHz", async () => {
    const h = stubAudio();
    vi.stubGlobal("AudioContext", class extends FakeContext {
      constructor() { super({ sampleRate: 48_000 }); }
    });
    await h.duplex.start();
    h.worklets[0]!.port.onmessage!({ data: Float32Array.of(0.5) });
    expect(h.captured[0]!.rate).toBe(48_000);
    await h.duplex.close();
  });

  it("plays agent audio into a media stream and never into the speakers", async () => {
    const h = stubAudio();
    await h.duplex.start();
    expect(h.duplex.stream).toBe(h.playback().sink.stream);
    expect(h.duplex.track).toBe(h.playback().agentTrack);
    h.duplex.play(pcm(0, 16_384, -16_384));
    const source = h.playback().sources[0]!;
    expect(source.buffer!.sampleRate).toBe(24_000);
    expect(source.targets).toEqual([h.playback().sink]);
    expect(source.start).toHaveBeenCalledOnce();
    for (const context of [h.capture(), h.playback()]) {
      for (const node of context.nodes) expect(node.targets).not.toContain(context.destination);
    }
    await h.duplex.close();
  });

  it("schedules consecutive chunks without a gap", async () => {
    const h = stubAudio();
    await h.duplex.start();
    h.duplex.play(pcm(...new Array<number>(240).fill(0)));
    h.duplex.play(pcm(...new Array<number>(240).fill(0)));
    expect(h.playback().sources[0]!.start).toHaveBeenCalledWith(0);
    expect(h.playback().sources[1]!.start).toHaveBeenCalledWith(0.01);
    await h.duplex.close();
  });

  it("stops every scheduled source and empties the queue on flush", async () => {
    const h = stubAudio();
    await h.duplex.start();
    for (let index = 0; index < 3; index += 1) h.duplex.play(pcm(1, 2, 3));
    expect(h.duplex.scheduled).toBe(3);
    h.duplex.flush();
    expect(h.duplex.scheduled).toBe(0);
    for (const source of h.playback().sources) {
      expect(source.stop).toHaveBeenCalledOnce();
      expect(source.disconnect).toHaveBeenCalledOnce();
    }
    h.playback().currentTime = 5;
    h.duplex.play(pcm(1, 2, 3));
    expect(h.playback().sources[3]!.start).toHaveBeenCalledWith(5);
    await h.duplex.close();
  });

  it("stops capture and closes both contexts on close", async () => {
    const h = stubAudio();
    await h.duplex.start();
    h.duplex.play(pcm(1, 2, 3));
    await h.duplex.close();
    expect(h.microphoneTrack.stop).toHaveBeenCalledOnce();
    expect(h.capture().close).toHaveBeenCalledOnce();
    expect(h.playback().close).toHaveBeenCalledOnce();
    expect(h.duplex.scheduled).toBe(0);
    expect(() => h.duplex.stream).toThrow("not started");
    h.duplex.play(pcm(1, 2, 3));
    expect(h.playback().sources).toHaveLength(1);
  });

  it("releases the microphone when the worklet module fails to load", async () => {
    const h = stubAudio();
    vi.stubGlobal("AudioContext", class extends FakeContext {
      override audioWorklet = { addModule: vi.fn(async () => { throw new Error("blocked"); }) };
    });
    await expect(h.duplex.start()).rejects.toThrow("blocked");
    expect(h.microphoneTrack.stop).toHaveBeenCalledOnce();
    expect(h.capture().close).toHaveBeenCalledOnce();
    expect(h.playback().close).toHaveBeenCalledOnce();
  });

  it("releases the microphone when the playback context cannot be built", async () => {
    const h = stubAudio();
    vi.stubGlobal("AudioContext", class extends FakeContext {
      constructor(options: { sampleRate?: number } = {}) {
        super(options);
        if (options.sampleRate === 24_000) throw new Error("hardware in use");
      }
    });
    await expect(h.duplex.start()).rejects.toThrow("hardware in use");
    expect(h.microphoneTrack.stop).toHaveBeenCalledOnce();
  });

  it("rebuilds the capture context at the device rate when the pinned rate is refused", async () => {
    const h = stubAudio();
    vi.stubGlobal("AudioContext", class extends FakeContext {
      override createMediaStreamSource = vi.fn(() => {
        if (this.pinned) throw new Error("connecting AudioNodes from AudioContexts with different sample-rate");
        return new FakeNode();
      });
    });
    await h.duplex.start();
    expect(FakeContext.instances.map((context) => context.sampleRate)).toEqual([24_000, 16_000, 48_000]);
    expect(FakeContext.instances[1]!.close).toHaveBeenCalledOnce();
    expect(h.capture().pinned).toBe(false);
    expect(h.capture().close).not.toHaveBeenCalled();
    expect(h.capture().modules).toEqual(["blob:jarvis-pcm"]);
    h.worklets[0]!.port.onmessage!({ data: Float32Array.of(0.5) });
    expect(h.captured[0]!.rate).toBe(48_000);
    await h.duplex.close();
  });
});
