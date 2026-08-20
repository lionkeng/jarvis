import type { NormalizedRealtimeEvent, RealtimeEventListener, RealtimeToolResult, RealtimeTransport } from "@jarvis-viz/core";
import { DemoVoiceFeatureSource } from "../demo-transport.js";

export type VoiceDemoScriptId =
  | "navigate"
  | "navigate-scroll"
  | "select"
  | "open-details"
  | "close-details"
  | "focus"
  | "activate"
  | "question";

interface VoiceDemoScript {
  id: VoiceDemoScriptId;
  user: string;
  agent: string;
  argumentsJson?: string;
}

const SCRIPTS: Record<VoiceDemoScriptId, VoiceDemoScript> = {
  navigate: {
    id: "navigate",
    user: "Open the library.",
    agent: "Opening the library.",
    argumentsJson: JSON.stringify({ actions: [{ type: "navigate", target: "library" }] }),
  },
  "navigate-scroll": {
    id: "navigate-scroll",
    user: "Open the article and scroll to the bottom.",
    agent: "Opened the article and scrolled to the bottom.",
    argumentsJson: JSON.stringify({
      actions: [
        { type: "navigate", target: "article" },
        { type: "scroll", target: "article.content", direction: "bottom" },
      ],
    }),
  },
  select: {
    id: "select",
    user: "Open the library and select Atlas.",
    agent: "Selected Atlas.",
    argumentsJson: JSON.stringify({
      actions: [
        { type: "navigate", target: "library" },
        { type: "select", target: "library.item", value: "atlas" },
      ],
    }),
  },
  "open-details": {
    id: "open-details",
    user: "Open the library details.",
    agent: "Opened the details panel.",
    argumentsJson: JSON.stringify({
      actions: [
        { type: "navigate", target: "library" },
        { type: "open", target: "library.details" },
      ],
    }),
  },
  "close-details": {
    id: "close-details",
    user: "Close the library details.",
    agent: "Closed the details panel.",
    argumentsJson: JSON.stringify({ actions: [{ type: "close", target: "library.details" }] }),
  },
  focus: {
    id: "focus",
    user: "Focus the dashboard search field.",
    agent: "Search is focused.",
    argumentsJson: JSON.stringify({
      actions: [
        { type: "navigate", target: "dashboard" },
        { type: "focus", target: "dashboard.search" },
      ],
    }),
  },
  activate: {
    id: "activate",
    user: "Bookmark the article.",
    agent: "Toggled the article bookmark.",
    argumentsJson: JSON.stringify({
      actions: [
        { type: "navigate", target: "article" },
        { type: "activate", target: "article.bookmark" },
      ],
    }),
  },
  question: {
    id: "question",
    user: "What does this demo visualize?",
    agent: "It visualizes the remote agent audio while this page keeps UI commands on a separate actor.",
  },
};

export const VOICE_DEMO_SCRIPTS: ReadonlyArray<{ id: VoiceDemoScriptId; label: string }> = [
  { id: "navigate", label: "Open the library" },
  { id: "navigate-scroll", label: "Open article and scroll" },
  { id: "select", label: "Select Atlas" },
  { id: "open-details", label: "Open library details" },
  { id: "close-details", label: "Close library details" },
  { id: "focus", label: "Focus search" },
  { id: "activate", label: "Bookmark the article" },
  { id: "question", label: "Ask an ordinary question" },
];

export class VoiceDemoTransport implements RealtimeTransport {
  #listeners = new Set<RealtimeEventListener>();
  #timers = new Set<number>();
  #connected = false;
  #run = 0;
  #seq = 0;
  #pendingCallId: string | undefined;
  readonly #toolResults: RealtimeToolResult[] = [];

  constructor(readonly signal = new DemoVoiceFeatureSource()) {}

  get connected(): boolean { return this.#connected; }
  get agentAudio(): MediaStreamTrack | null { return null; }
  get submittedToolResults(): readonly RealtimeToolResult[] { return this.#toolResults; }
  get pendingCallId(): string | undefined { return this.#pendingCallId; }

  subscribe(listener: RealtimeEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async connect(): Promise<void> {
    this.disconnect();
    this.#connected = true;
    this.signal.setAgentSpeaking(false);
    this.#emit({ type: "connected" });
  }

  disconnect(): void {
    this.#run += 1;
    for (const timer of this.#timers) window.clearTimeout(timer);
    this.#timers.clear();
    this.#pendingCallId = undefined;
    const wasConnected = this.#connected;
    this.#connected = false;
    this.signal.setAgentSpeaking(false);
    if (wasConnected) this.#emit({ type: "disconnected" });
  }

  submitToolResult(result: RealtimeToolResult): void {
    this.#toolResults.push(result);
    if (!this.#connected || this.#pendingCallId !== result.callId) return;
    this.#pendingCallId = undefined;
    if (result.continueResponse === false) return;
    this.#stream(acknowledgement(result.output));
  }

  playScript(id: VoiceDemoScriptId): void {
    if (!this.#connected) return;
    const script = SCRIPTS[id];
    this.signal.setAgentSpeaking(false);
    this.#emit({ type: "user-speech-started" });
    this.#later(120, () => {
      this.#emit({ type: "user-speech-stopped" });
      this.#emit({ type: "user-text", text: script.user });
      if (script.argumentsJson === undefined) {
        this.#later(80, () => this.#stream(script.agent));
        return;
      }
      this.#seq += 1;
      const callId = `call_${script.id}_${this.#seq}`;
      this.#pendingCallId = callId;
      this.#emit({
        type: "tool-call",
        call: { callId, name: "perform_ui_actions", argumentsJson: script.argumentsJson },
      });
    });
  }

  #stream(text: string): void {
    this.signal.setAgentSpeaking(true);
    this.#emit({ type: "agent-audio-started" });
    const chunks = text.match(/\S+\s*/g) ?? [text];
    chunks.forEach((chunk, index) => this.#later(index * 40, () => this.#emit({ type: "agent-text-delta", delta: chunk, audioSynchronized: true })));
    this.#later(chunks.length * 40 + 40, () => {
      this.signal.setAgentSpeaking(false);
      this.#emit({ type: "agent-text-done", text, audioSynchronized: true });
      this.#emit({ type: "response-done" });
    });
  }

  #later(delay: number, callback: () => void): void {
    const run = this.#run;
    const timer = window.setTimeout(() => {
      this.#timers.delete(timer);
      if (this.#connected && this.#run === run) callback();
    }, delay);
    this.#timers.add(timer);
  }

  #emit(event: NormalizedRealtimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

function acknowledgement(output: string): string {
  try {
    const parsed: unknown = JSON.parse(output);
    if (parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    return "Done.";
  }
  return "Done.";
}
