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
  let expiryTimer: RoomTimer | null = null;
  const stop = () => {
    stopped = true;
    if (timer !== null) clock.clearTimeout(timer);
    if (expiryTimer !== null) clock.clearTimeout(expiryTimer);
  };
  const expire = () => {
    stop();
    options.onExpired();
  };

  const wait = (at: number) => {
    timer = clock.setTimeout(() => void run(), Math.max(0, at - clock.now()));
  };
  const arm = (notBefore = clock.now()) => {
    if (expiryTimer !== null) clock.clearTimeout(expiryTimer);
    expiryTimer = clock.setTimeout(expire, Math.max(0, expiresAt - clock.now()));
    if (host.auth.refresh) wait(Math.max(notBefore, expiresAt - REFRESH_LEAD_MS));
  };

  const run = async () => {
    timer = null;
    if (stopped) return;
    if (!host.auth.refresh || clock.now() >= expiresAt) return expire();
    try {
      const decision = await host.auth.refresh(request);
      if (stopped) return;
      if (clock.now() >= expiresAt) return expire();
      if (decision.ok && decision.expiresAt !== undefined && decision.expiresAt <= clock.now())
        return expire();
      options.onDecision(decision);
      if (stopped) return;
      if (!decision.ok || decision.expiresAt === undefined) return stop();
      expiresAt = decision.expiresAt;
      arm(clock.now() + REFRESH_RETRY_MS);
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
  return stop;
}
