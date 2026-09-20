function isLoopbackHost(hostname: string): boolean {
  const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

// A serialized origin always contains "://", so this key cannot collide with one.
const LOOPBACK_BUCKET = "loopback";

export interface AdmittedOrigin {
  /** Normalized form of the request's Origin header. Echo this in CORS headers. */
  readonly origin: string;
  /**
   * Key for every per-origin counter. Every spelling of one origin maps to the same key.
   * The loopback rule accepts any loopback host and port, so all loopback origins share one key.
   */
  readonly bucket: string;
}

export class OriginGuard {
  readonly #allowed: Set<string>;
  readonly #allowLoopback: boolean;

  constructor(origins: readonly string[]) {
    this.#allowed = new Set(origins.map((origin) => new URL(origin).origin));
    this.#allowLoopback = [...this.#allowed].some((origin) => isLoopbackHost(new URL(origin).hostname));
  }

  admit(origin: string | null): AdmittedOrigin | undefined {
    if (!origin) return undefined;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return undefined;
    }
    const loopback = this.#allowLoopback && (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHost(url.hostname);
    if (!loopback && !this.#allowed.has(url.origin)) return undefined;
    return { origin: url.origin, bucket: loopback ? LOOPBACK_BUCKET : url.origin };
  }

  allows(origin: string | null): boolean {
    return this.admit(origin) !== undefined;
  }
}
