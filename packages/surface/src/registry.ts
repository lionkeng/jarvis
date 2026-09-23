import type { VoiceCapability, VoiceCommand, VoiceControl, VoiceOutcome } from "./types.js";

export const CAPABILITY_READY_TIMEOUT_MS = 2_000;

export type CapabilityErrorCode = "target_unavailable" | "cancelled" | "execution_failed";

export class DuplicateCapabilityError extends Error {
  constructor(id: string) {
    super(`Capability ${id} is already registered`);
    this.name = "DuplicateCapabilityError";
  }
}

export class CapabilityRegistryError extends Error {
  readonly code: CapabilityErrorCode;

  constructor(code: CapabilityErrorCode, message: string) {
    super(message);
    this.name = "CapabilityRegistryError";
    this.code = code;
  }
}

type Waiter = {
  id: string;
  resolve: (capability: VoiceCapability) => void;
  reject: (error: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  onAbort: () => void;
};

type Settler = {
  resolve: () => void;
  reject: (error: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  onAbort: () => void;
};

export class VoiceRegistry {
  readonly #capabilities = new Map<string, VoiceCapability>();
  readonly #waiters = new Set<Waiter>();
  readonly #settlers = new Set<Settler>();

  register(capability: VoiceCapability): () => void {
    const id = capability.describe().control.id;
    if (this.#capabilities.has(id)) throw new DuplicateCapabilityError(id);
    this.#capabilities.set(id, capability);
    this.#restartSettlers();
    for (const waiter of [...this.#waiters]) {
      if (waiter.id !== id) continue;
      this.#finishWait(waiter);
      waiter.resolve(capability);
    }
    return () => {
      if (this.#capabilities.get(id) === capability) this.unregister(id);
    };
  }

  unregister(id: string): void {
    if (!this.#capabilities.delete(id)) return;
    this.#restartSettlers();
  }

  describe(): { controls: VoiceControl[]; facts: Record<string, string> } {
    const controls: VoiceControl[] = [];
    const facts: Record<string, string> = {};
    for (const capability of this.#capabilities.values()) {
      const description = capability.describe();
      controls.push(description.control);
      if (description.facts) Object.assign(facts, description.facts);
    }
    return { controls, facts };
  }

  settle(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new CapabilityRegistryError("cancelled", "Settle aborted"));
    return new Promise<void>((resolve, reject) => {
      const settler: Settler = {
        resolve,
        reject,
        timeoutId: setTimeout(() => {
          this.#finishSettle(settler);
          resolve();
        }, 0),
        signal,
        onAbort: () => {
          this.#finishSettle(settler);
          reject(new CapabilityRegistryError("cancelled", "Settle aborted"));
        },
      };
      this.#settlers.add(settler);
      signal.addEventListener("abort", settler.onAbort, { once: true });
    });
  }

  waitFor(id: string, signal: AbortSignal): Promise<VoiceCapability> {
    const existing = this.#capabilities.get(id);
    if (existing) return Promise.resolve(existing);
    if (signal.aborted) return Promise.reject(new CapabilityRegistryError("cancelled", `Wait for ${id} aborted`));
    return new Promise<VoiceCapability>((resolve, reject) => {
      const waiter: Waiter = {
        id,
        resolve,
        reject,
        timeoutId: setTimeout(() => {
          this.#finishWait(waiter);
          reject(new CapabilityRegistryError("target_unavailable", `Timed out waiting for ${id}`));
        }, CAPABILITY_READY_TIMEOUT_MS),
        signal,
        onAbort: () => {
          this.#finishWait(waiter);
          reject(new CapabilityRegistryError("cancelled", `Wait for ${id} aborted`));
        },
      };
      this.#waiters.add(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  async execute(command: VoiceCommand, signal: AbortSignal): Promise<VoiceOutcome> {
    const capability = await this.waitFor(command.control, signal);
    const control = this.describe().controls.find((candidate) => candidate.id === command.control);
    if (control === undefined || control.kind !== command.kind) {
      throw new CapabilityRegistryError("execution_failed", `${command.control} does not accept ${command.kind} right now`);
    }
    if ((command.kind === "pick" || command.kind === "toggle") && "items" in control) {
      if (!control.items.some((item) => item.id === command.item)) {
        throw new CapabilityRegistryError("execution_failed", `${command.control} does not list ${command.item}`);
      }
    }
    if (command.kind === "adjust" && "axes" in control) {
      if (!control.axes.some((axis) => axis.id === command.axis)) {
        throw new CapabilityRegistryError("execution_failed", `${command.control} does not list ${command.axis}`);
      }
    }
    return capability.execute(command, signal);
  }

  #restartSettlers(): void {
    for (const settler of this.#settlers) {
      clearTimeout(settler.timeoutId);
      settler.timeoutId = setTimeout(() => {
        this.#finishSettle(settler);
        settler.resolve();
      }, 0);
    }
  }

  #finishWait(waiter: Waiter): void {
    clearTimeout(waiter.timeoutId);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    this.#waiters.delete(waiter);
  }

  #finishSettle(settler: Settler): void {
    clearTimeout(settler.timeoutId);
    settler.signal.removeEventListener("abort", settler.onAbort);
    this.#settlers.delete(settler);
  }
}
