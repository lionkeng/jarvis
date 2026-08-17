import type { TranscriptListener, TranscriptMessage, TranscriptRole, TranscriptSnapshot, TranscriptStatus } from "./types.js";

export class TranscriptStore {
  #messages: TranscriptMessage[] = [];
  #revision = 0;
  #snapshot: TranscriptSnapshot = { messages: this.#messages, revision: 0 };
  #listeners = new Set<TranscriptListener>();
  #nextId = 1;

  getSnapshot = (): TranscriptSnapshot => this.#snapshot;

  subscribe = (listener: TranscriptListener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  appendDelta(role: TranscriptRole, delta: string, now = performance.now()): TranscriptMessage {
    const last = this.#messages.at(-1);
    if (last?.role === role && last.status === "streaming") {
      const updated = { ...last, text: last.text + delta, updatedAt: now };
      this.#messages = [...this.#messages.slice(0, -1), updated];
      this.#publish();
      return updated;
    }
    const message: TranscriptMessage = {
      id: `message-${this.#nextId++}`,
      role,
      text: delta,
      startedAt: now,
      updatedAt: now,
      status: "streaming",
    };
    this.#messages = [...this.#messages, message];
    this.#publish();
    return message;
  }

  appendMessage(role: TranscriptRole, text: string, now = performance.now()): TranscriptMessage {
    const current = this.#messages.at(-1);
    if (current?.role === role && current.status === "streaming") this.complete(role, "complete", now);
    const message: TranscriptMessage = {
      id: `message-${this.#nextId++}`,
      role,
      text,
      startedAt: now,
      updatedAt: now,
      status: "complete",
    };
    this.#messages = [...this.#messages, message];
    this.#publish();
    return message;
  }

  complete(role?: TranscriptRole, status: Extract<TranscriptStatus, "complete" | "interrupted"> = "complete", now = performance.now()): void {
    let index = -1;
    for (let candidate = this.#messages.length - 1; candidate >= 0; candidate -= 1) {
      const message = this.#messages[candidate];
      if (message?.status === "streaming" && (role === undefined || message.role === role)) {
        index = candidate;
        break;
      }
    }
    if (index < 0) return;
    const current = this.#messages[index];
    if (!current) return;
    const next = [...this.#messages];
    next[index] = { ...current, status, updatedAt: now };
    this.#messages = next;
    this.#publish();
  }

  clear(): void {
    if (this.#messages.length === 0) return;
    this.#messages = [];
    this.#publish();
  }

  #publish(): void {
    this.#revision += 1;
    this.#snapshot = { messages: this.#messages, revision: this.#revision };
    const snapshot = this.#snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }
}
