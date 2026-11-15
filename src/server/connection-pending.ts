import type { RoomClock, RoomTimer } from '../protocol/clock.js';

/** Resource limits while authentication or room loading is unresolved. */
export interface RoomConnectionLimits {
  maxPendingFrames?: number | undefined;
  admissionTimeoutMs?: number | undefined;
  loadTimeoutMs?: number | undefined;
}

/** A bounded queue and deadline for a connection that has not joined. */
export interface PendingConnection {
  push(frame: Uint8Array): boolean;
  bytes(): number;
  drain(): Uint8Array[];
  arm(stage: 'admission' | 'load'): void;
  clear(): void;
}

/** Holds bounded copies so a transport cannot mutate frames awaiting admission. */
export function createPendingConnection(options: {
  clock: RoomClock;
  maxPendingBytes: number;
  limits?: RoomConnectionLimits | undefined;
  onTimeout(): void;
}): PendingConnection {
  const limits = {
    maxPendingFrames: options.limits?.maxPendingFrames ?? 64,
    maxPendingBytes: options.maxPendingBytes,
    admissionTimeoutMs: options.limits?.admissionTimeoutMs ?? 10_000,
    loadTimeoutMs: options.limits?.loadTimeoutMs ?? 30_000,
  };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid connection limit.');
  }
  let frames: Uint8Array[] = [];
  let bytes = 0;
  let timer: RoomTimer | null = null;
  const stop = () => {
    if (timer !== null) options.clock.clearTimeout(timer);
    timer = null;
  };
  return {
    bytes: () => bytes,
    push: (frame) => {
      if (
        frames.length >= limits.maxPendingFrames ||
        frame.byteLength + 64 > limits.maxPendingBytes - bytes
      )
        return false;
      frames.push(frame.slice());
      bytes += frame.byteLength + 64;
      return true;
    },
    drain: () => {
      stop();
      const pending = frames;
      frames = [];
      bytes = 0;
      return pending;
    },
    arm: (stage) => {
      stop();
      timer = options.clock.setTimeout(options.onTimeout, limits[`${stage}TimeoutMs`]);
    },
    clear: () => {
      stop();
      frames = [];
      bytes = 0;
    },
  };
}
