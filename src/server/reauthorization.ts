import type { RoomTimer } from '../protocol/clock.js';
import type { RoomAdmission, RoomRefreshRequest } from './host/adapters.js';
import type { ResolvedRoomHost } from './host/host.js';

/** A decision is refreshed this long before it expires. */
const REFRESH_LEAD_MS = 30_000;
/** A refresh that throws is tried again after this long, until the decision expires. */
const REFRESH_RETRY_MS = 5_000;

export interface ReauthorizationOptions {
  host: ResolvedRoomHost;
  request: RoomRefreshRequest;
  expiresAt: number;
  /** Receives every decision `refresh` returns. */
  onDecision(decision: RoomAdmission): void;
  /** Called when the decision expired without a fresh one. */
  onExpired(): void;
}

/** Refreshes a connection's decision before each expiry; returns what stops it. */
export function startReauthorization(options: ReauthorizationOptions): () => void {
  const { host, request } = options;
  const { clock } = host;
  let expiresAt = options.expiresAt;
  let timer: RoomTimer | null = null;
  let stopped = false;

  const wait = (at: number) => {
    timer = clock.setTimeout(() => void run(), Math.max(0, at - clock.now()));
  };
  const arm = () => wait(host.auth.refresh ? expiresAt - REFRESH_LEAD_MS : expiresAt);

  const run = async () => {
    timer = null;
    if (!host.auth.refresh || clock.now() >= expiresAt) return options.onExpired();
    try {
      const decision = await host.auth.refresh(request);
      if (stopped) return;
      options.onDecision(decision);
      if (!decision.ok || decision.expiresAt === undefined) return;
      expiresAt = decision.expiresAt;
      arm();
    } catch (error) {
      if (stopped) return;
      host.logger.warn('Refreshing a connection’s access failed; retrying.', {
        room: request.room,
        error,
      });
      wait(Math.min(clock.now() + REFRESH_RETRY_MS, expiresAt));
    }
  };

  arm();
  return () => {
    stopped = true;
    if (timer !== null) clock.clearTimeout(timer);
  };
}
