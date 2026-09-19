export const PCM_CAPTURE_RATE = 16_000;
export const PCM_PLAYBACK_RATE = 24_000;

const PROCESSOR = "jarvis-pcm-capture";
const PROCESSOR_SOURCE = `
const FRAMES = 512;
class JarvisPcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.block = new Float32Array(FRAMES); this.filled = 0; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(FRAMES - this.filled, channel.length - offset);
      this.block.set(channel.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === FRAMES) { this.port.postMessage(this.block.slice(0)); this.filled = 0; }
    }
    return true;
  }
}
registerProcessor(${JSON.stringify(PROCESSOR)}, JarvisPcmCapture);
`;

export interface PcmDuplexOptions {
  capture: (pcm16: ArrayBuffer, sampleRate: number) => void;
}

interface PcmGraph {
  capture: AudioContext;
  playback: AudioContext;
  microphone: MediaStream;
  source: MediaStreamAudioSourceNode;
  worklet: AudioWorkletNode;
  sink: MediaStreamAudioDestinationNode;
  stream: MediaStream;
  track: MediaStreamTrack;
}

export class PcmDuplex {
  readonly #capture: (pcm16: ArrayBuffer, sampleRate: number) => void;
  readonly #playing = new Set<AudioBufferSourceNode>();
  #graph: PcmGraph | undefined;
  #playhead = 0;
  #closed = false;

  constructor(options: PcmDuplexOptions) {
    this.#capture = options.capture;
  }

  get stream(): MediaStream { return this.#require().stream; }
  get track(): MediaStreamTrack { return this.#require().track; }
  get sampleRate(): number { return this.#require().capture.sampleRate; }
  get scheduled(): number { return this.#playing.size; }

  async start(): Promise<void> {
    const microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    if (this.#closed) { stopTracks(microphone); throw new Error("Live audio is closed"); }
    const playback = new AudioContext({ sampleRate: PCM_PLAYBACK_RATE, latencyHint: "interactive" });
    const url = URL.createObjectURL(new Blob([PROCESSOR_SOURCE], { type: "text/javascript" }));
    let capture: AudioContext | undefined;
    try {
      const opened = await openCapture(url, microphone, true);
      capture = opened.capture;
      if (this.#closed) throw new Error("Live audio is closed");
      const worklet = new AudioWorkletNode(opened.capture, PROCESSOR);
      worklet.port.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (data instanceof Float32Array) this.#capture(toPcm16(data), opened.capture.sampleRate);
      };
      opened.source.connect(worklet);
      const sink = playback.createMediaStreamDestination();
      const [track] = sink.stream.getAudioTracks();
      if (!track) throw new Error("Live playback stream carries no audio track");
      this.#graph = { capture: opened.capture, playback, microphone, source: opened.source, worklet, sink, stream: sink.stream, track };
      void opened.capture.resume();
      void playback.resume();
    } catch (error) {
      stopTracks(microphone);
      await Promise.all([capture ? close(capture) : undefined, close(playback)]);
      throw error;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  play(pcm16: ArrayBuffer): void {
    const graph = this.#graph;
    const frames = pcm16.byteLength >> 1;
    if (!graph || this.#closed || frames === 0) return;
    const buffer = graph.playback.createBuffer(1, frames, PCM_PLAYBACK_RATE);
    const channel = buffer.getChannelData(0);
    const view = new DataView(pcm16);
    for (let index = 0; index < frames; index += 1) channel[index] = view.getInt16(index * 2, true) / 0x8000;
    const source = graph.playback.createBufferSource();
    source.buffer = buffer;
    source.connect(graph.sink);
    source.onended = () => { this.#playing.delete(source); };
    const at = Math.max(graph.playback.currentTime, this.#playhead);
    this.#playing.add(source);
    source.start(at);
    this.#playhead = at + buffer.duration;
  }

  flush(): void {
    for (const source of this.#playing) {
      source.onended = null;
      try { source.stop(); } catch {}
      source.disconnect();
    }
    this.#playing.clear();
    this.#playhead = 0;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const graph = this.#graph;
    this.#graph = undefined;
    if (graph) stopTracks(graph.microphone);
    this.flush();
    if (!graph) return;
    graph.worklet.port.onmessage = null;
    graph.source.disconnect();
    graph.worklet.disconnect();
    graph.sink.disconnect();
    await Promise.all([close(graph.capture), close(graph.playback)]);
  }

  #require(): PcmGraph {
    const graph = this.#graph;
    if (!graph) throw new Error("Live audio is not started");
    return graph;
  }
}

async function openCapture(url: string, microphone: MediaStream, pinned: boolean): Promise<{ capture: AudioContext; source: MediaStreamAudioSourceNode }> {
  const capture = pinned
    ? new AudioContext({ sampleRate: PCM_CAPTURE_RATE, latencyHint: "interactive" })
    : new AudioContext({ latencyHint: "interactive" });
  try {
    await capture.audioWorklet.addModule(url);
  } catch (error) {
    await close(capture);
    throw error;
  }
  try {
    return { capture, source: capture.createMediaStreamSource(microphone) };
  } catch (error) {
    await close(capture);
    if (!pinned) throw error;
    return openCapture(url, microphone, false);
  }
}

function toPcm16(frames: Float32Array): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(frames.length * 2));
  for (let index = 0; index < frames.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, frames[index] ?? 0));
    view.setInt16(index * 2, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true);
  }
  return view.buffer;
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

async function close(context: AudioContext): Promise<void> {
  if (context.state === "closed") return;
  try { await context.close(); } catch {}
}
