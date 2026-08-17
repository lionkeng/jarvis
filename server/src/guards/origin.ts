export class OriginGuard {
  readonly #allowed: Set<string>;

  constructor(origins: readonly string[]) {
    this.#allowed = new Set(origins.map((origin) => new URL(origin).origin));
  }

  allows(origin: string | null): boolean {
    if (!origin) return false;
    try { return this.#allowed.has(new URL(origin).origin); } catch { return false; }
  }
}
