function isLoopbackHost(hostname: string): boolean {
  const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export class OriginGuard {
  readonly #allowed: Set<string>;
  readonly #allowLoopback: boolean;

  constructor(origins: readonly string[]) {
    this.#allowed = new Set(origins.map((origin) => new URL(origin).origin));
    this.#allowLoopback = [...this.#allowed].some((origin) => isLoopbackHost(new URL(origin).hostname));
  }

  allows(origin: string | null): boolean {
    if (!origin) return false;
    try {
      const url = new URL(origin);
      if (this.#allowed.has(url.origin)) return true;
      if (!this.#allowLoopback) return false;
      if (url.protocol !== "http:" && url.protocol !== "https:") return false;
      return isLoopbackHost(url.hostname);
    } catch {
      return false;
    }
  }
}
