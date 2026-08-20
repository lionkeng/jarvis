import { useLayoutEffect, useRef } from "react";
import {
  CAPABILITY_READY_TIMEOUT_MS,
  type UiCommand,
} from "./interaction-contract.js";

export const NAVIGATION_CAPABILITY_ID = "navigation";

export class DuplicateCapabilityError extends Error {
  constructor(id: string) {
    super(`Capability ${id} is already registered`);
    this.name = "DuplicateCapabilityError";
  }
}

export class CapabilityRegistryError extends Error {
  readonly code: "target_unavailable" | "cancelled" | "execution_failed";

  constructor(code: "target_unavailable" | "cancelled" | "execution_failed", message: string) {
    super(message);
    this.name = "CapabilityRegistryError";
    this.code = code;
  }
}

export interface UiCapability {
  readonly supportedActions: readonly UiCommand["type"][];
  execute(command: UiCommand, signal: AbortSignal): Promise<void>;
}

type Waiter = {
  id: string;
  resolve: (capability: UiCapability) => void;
  reject: (error: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  onAbort: () => void;
};

export function capabilityIdFor(command: UiCommand): string {
  switch (command.type) {
    case "navigate":
      return NAVIGATION_CAPABILITY_ID;
    case "open":
    case "close":
    case "select":
    case "scroll":
    case "focus":
    case "activate":
      return command.target;
    default: {
      const _exhaustive: never = command;
      throw new Error(`Unexpected command ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export class UiCapabilityRegistry {
  readonly #capabilities = new Map<string, UiCapability>();
  readonly #waiters = new Set<Waiter>();

  register(id: string, capability: UiCapability): void {
    if (this.#capabilities.has(id)) throw new DuplicateCapabilityError(id);
    this.#capabilities.set(id, capability);
    for (const waiter of [...this.#waiters]) {
      if (waiter.id !== id) continue;
      this.#finishWait(waiter);
      waiter.resolve(capability);
    }
  }

  unregister(id: string): void {
    this.#capabilities.delete(id);
  }

  waitFor(id: string, signal: AbortSignal): Promise<UiCapability> {
    const existing = this.#capabilities.get(id);
    if (existing) return Promise.resolve(existing);
    if (signal.aborted) return Promise.reject(new CapabilityRegistryError("cancelled", `Wait for ${id} aborted`));
    return new Promise((resolve, reject) => {
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

  async execute(command: UiCommand, signal: AbortSignal): Promise<void> {
    const id = capabilityIdFor(command);
    const capability = await this.waitFor(id, signal);
    if (!capability.supportedActions.includes(command.type)) {
      throw new CapabilityRegistryError("execution_failed", `Capability ${id} does not support ${command.type}`);
    }
    await capability.execute(command, signal);
  }

  #finishWait(waiter: Waiter): void {
    clearTimeout(waiter.timeoutId);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    this.#waiters.delete(waiter);
  }
}

export function useUiCapability(registry: UiCapabilityRegistry, id: string, capability: UiCapability): void {
  const capabilityRef = useRef(capability);
  capabilityRef.current = capability;
  useLayoutEffect(() => {
    const registered: UiCapability = {
      get supportedActions() {
        return capabilityRef.current.supportedActions;
      },
      execute(command, signal) {
        return capabilityRef.current.execute(command, signal);
      },
    };
    registry.register(id, registered);
    return () => {
      registry.unregister(id);
    };
  }, [registry, id]);
}
