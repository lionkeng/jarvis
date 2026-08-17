import { firstGrapheme, isCjkGrapheme } from "./segmentation.js";

export interface AudioTextSyncOptions {
  charactersPerSecond?: number;
  initialCharacterCredit?: number;
  silenceHoldMs?: number;
  startupTimeoutMs?: number;
}

export interface AudioTextSyncTick {
  audioStarted: boolean;
  completed: boolean;
}

const DEFAULT_CHARACTERS_PER_SECOND = 18;
const DEFAULT_INITIAL_CHARACTER_CREDIT = 8;
const DEFAULT_SILENCE_HOLD_MS = 850;
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const MAX_TICK_MS = 250;

/**
 * Paces provider transcript deltas against audible WebRTC playback.
 *
 * Realtime transcript events and the remote media track do not share a playout
 * timestamp. This queue therefore uses detected speech time as the clock and
 * releases append-stable word chunks at a conversational reading rate.
 */
export class AudioTextSynchronizer {
  readonly #append: (delta: string, now: number) => void;
  readonly #baseCharactersPerSecond: number;
  readonly #initialCharacterCredit: number;
  readonly #silenceHoldMs: number;
  readonly #startupTimeoutMs: number;
  #active = false;
  #sourceDone = false;
  #heardAudio = false;
  #receivedText = "";
  #queue = "";
  #characterCredit = 0;
  #startedAt = 0;
  #lastTickAt = 0;
  #silentSince = 0;
  #rateMultiplier = 1;

  constructor(append: (delta: string, now: number) => void, options: AudioTextSyncOptions = {}) {
    this.#append = append;
    this.#baseCharactersPerSecond = positive(options.charactersPerSecond, DEFAULT_CHARACTERS_PER_SECOND);
    this.#initialCharacterCredit = positive(options.initialCharacterCredit, DEFAULT_INITIAL_CHARACTER_CREDIT);
    this.#silenceHoldMs = positive(options.silenceHoldMs, DEFAULT_SILENCE_HOLD_MS);
    this.#startupTimeoutMs = positive(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
  }

  get active(): boolean {
    return this.#active;
  }

  setRateMultiplier(multiplier: number): void {
    this.#rateMultiplier = positive(multiplier, 1);
  }

  enqueue(delta: string, now = performance.now()): void {
    if (!delta) return;
    this.#begin(now);
    this.#receivedText += delta;
    this.#queue += delta;
  }

  finish(finalText?: string, now = performance.now()): void {
    this.#begin(now);
    if (finalText) {
      if (!this.#receivedText) {
        this.#receivedText = finalText;
        this.#queue += finalText;
      } else if (finalText.startsWith(this.#receivedText)) {
        const missing = finalText.slice(this.#receivedText.length);
        this.#receivedText = finalText;
        this.#queue += missing;
      }
    }
    this.#sourceDone = true;
  }

  tick(now: number, audible: boolean): AudioTextSyncTick {
    if (!this.#active) return { audioStarted: false, completed: false };
    const elapsed = this.#lastTickAt === 0 ? 0 : Math.min(MAX_TICK_MS, Math.max(0, now - this.#lastTickAt));
    this.#lastTickAt = now;
    let audioStarted = false;

    if (audible) {
      if (!this.#heardAudio) {
        this.#heardAudio = true;
        audioStarted = true;
        this.#characterCredit += this.#initialCharacterCredit;
      }
      this.#silentSince = 0;
      this.#characterCredit = Math.min(
        Math.max(64, this.#charactersPerSecond * 2),
        this.#characterCredit + elapsed * this.#charactersPerSecond / 1_000,
      );
      this.#releaseReadyWords(now);
    } else if (this.#heardAudio) {
      if (this.#silentSince === 0) this.#silentSince = now;
    }

    const audibleTailEnded = this.#sourceDone
      && this.#heardAudio
      && this.#silentSince > 0
      && now - this.#silentSince >= this.#silenceHoldMs;
    const audioNeverStarted = this.#sourceDone && !this.#heardAudio && now - this.#startedAt >= this.#startupTimeoutMs;
    if (!audibleTailEnded && !audioNeverStarted) return { audioStarted, completed: false };

    this.#flush(now);
    this.#reset();
    return { audioStarted, completed: true };
  }

  interrupt(): boolean {
    if (!this.#active) return false;
    this.#reset();
    return true;
  }

  #begin(now: number): void {
    if (this.#active) return;
    this.#active = true;
    this.#startedAt = now;
  }

  #releaseReadyWords(now: number): void {
    while (this.#queue) {
      const chunk = nextWordChunk(this.#queue, this.#sourceDone);
      if (!chunk || chunk.length > this.#characterCredit) return;
      this.#queue = this.#queue.slice(chunk.length);
      this.#characterCredit -= chunk.length;
      this.#append(chunk, now);
    }
  }

  #flush(now: number): void {
    if (!this.#queue) return;
    this.#append(this.#queue, now);
    this.#queue = "";
  }

  get #charactersPerSecond(): number {
    return this.#baseCharactersPerSecond * this.#rateMultiplier;
  }

  #reset(): void {
    this.#active = false;
    this.#sourceDone = false;
    this.#heardAudio = false;
    this.#receivedText = "";
    this.#queue = "";
    this.#characterCredit = 0;
    this.#startedAt = 0;
    this.#lastTickAt = 0;
    this.#silentSince = 0;
  }
}

function nextWordChunk(queue: string, sourceDone: boolean): string | undefined {
  const completeWord = /^\s*\S+\s+/u.exec(queue)?.[0];
  if (completeWord) return completeWord;
  const leadingWhitespace = /^\s*/u.exec(queue)?.[0] ?? "";
  const grapheme = firstGrapheme(queue.slice(leadingWhitespace.length));
  if (grapheme && isCjkGrapheme(grapheme)) return leadingWhitespace + grapheme;
  return sourceDone ? queue : undefined;
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
