import { createHash, timingSafeEqual } from 'crypto';

export interface IngressLimits {
  windowMs: number;
  perClientRateLimit: number;
  globalRateLimit: number;
  perClientMaxInFlight: number;
  globalMaxInFlight: number;
  maxClients: number;
}

interface ClientState {
  windowId: number;
  requests: number;
  inFlight: number;
}

export type IngressRejection = {
  accepted: false;
  reason: 'rate_limit' | 'backpressure' | 'client_capacity';
  retryAfterSeconds: number;
};

export type RateAdmission = { accepted: true } | IngressRejection;
export type WorkAdmission =
  | { accepted: true; release: () => void }
  | IngressRejection;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Verify the standard Bearer contract without ever comparing raw secrets.
 * Hashing both values also keeps timingSafeEqual on fixed-length buffers.
 */
export function hasValidBearerAuthorization(
  authorization: string | undefined,
  expectedToken: string | undefined,
): boolean {
  if (!authorization || !expectedToken) return false;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  const suppliedToken = match?.[1] ?? '';
  const equal = timingSafeEqual(digest(suppliedToken), digest(expectedToken));
  return match !== null && equal;
}

/**
 * Per-server fixed-window admission control. The client map has a hard cap;
 * unknown clients are rejected while the cap is occupied instead of evicting
 * active counters and making the rate limit bypassable.
 */
export class IngressAdmissionController {
  private readonly clients = new Map<string, ClientState>();
  private globalWindowId = -1;
  private globalRequests = 0;
  private globalInFlight = 0;

  constructor(private readonly limits: IngressLimits) {}

  private windowId(nowMs: number): number {
    return Math.floor(nowMs / this.limits.windowMs);
  }

  private retryAfterSeconds(nowMs: number): number {
    const nextBoundary = (this.windowId(nowMs) + 1) * this.limits.windowMs;
    return Math.max(1, Math.ceil((nextBoundary - nowMs) / 1_000));
  }

  private sweepExpired(currentWindowId: number): void {
    for (const [key, state] of this.clients) {
      if (state.windowId !== currentWindowId && state.inFlight === 0) {
        this.clients.delete(key);
      }
    }
  }

  admitRate(clientKey: string, nowMs = Date.now()): RateAdmission {
    const currentWindowId = this.windowId(nowMs);
    if (this.globalWindowId !== currentWindowId) {
      this.globalWindowId = currentWindowId;
      this.globalRequests = 0;
    }

    let client = this.clients.get(clientKey);
    if (!client) {
      if (this.clients.size >= this.limits.maxClients) {
        this.sweepExpired(currentWindowId);
      }
      if (this.clients.size >= this.limits.maxClients) {
        return {
          accepted: false,
          reason: 'client_capacity',
          retryAfterSeconds: this.retryAfterSeconds(nowMs),
        };
      }
      client = { windowId: currentWindowId, requests: 0, inFlight: 0 };
      this.clients.set(clientKey, client);
    } else if (client.windowId !== currentWindowId) {
      client.windowId = currentWindowId;
      client.requests = 0;
    }

    if (
      this.globalRequests >= this.limits.globalRateLimit ||
      client.requests >= this.limits.perClientRateLimit
    ) {
      return {
        accepted: false,
        reason: 'rate_limit',
        retryAfterSeconds: this.retryAfterSeconds(nowMs),
      };
    }

    this.globalRequests++;
    client.requests++;
    return { accepted: true };
  }

  acquireWork(clientKey: string): WorkAdmission {
    const client = this.clients.get(clientKey);
    // A route can only acquire after successful rate admission. Treat a missing
    // state as bounded client-capacity backpressure instead of allocating here.
    if (!client) {
      return { accepted: false, reason: 'client_capacity', retryAfterSeconds: 1 };
    }
    if (
      this.globalInFlight >= this.limits.globalMaxInFlight ||
      client.inFlight >= this.limits.perClientMaxInFlight
    ) {
      return { accepted: false, reason: 'backpressure', retryAfterSeconds: 1 };
    }

    this.globalInFlight++;
    client.inFlight++;
    let released = false;
    return {
      accepted: true,
      release: () => {
        if (released) return;
        released = true;
        this.globalInFlight = Math.max(0, this.globalInFlight - 1);
        client.inFlight = Math.max(0, client.inFlight - 1);
      },
    };
  }

  getClientStateCount(): number {
    return this.clients.size;
  }
}
