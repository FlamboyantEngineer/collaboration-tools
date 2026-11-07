import type { RoomAccess } from '../protocol/messages.js';

export type RoomConnectionStatus = 'connecting' | 'connected' | 'disconnected';

/** `pending` until the server grants access on the current socket. */
export type RoomConnectionAccess = 'pending' | RoomAccess;

/** What an editor needs to know about a provider's connection. */
export interface RoomConnectionState {
  status: RoomConnectionStatus;
  access: RoomConnectionAccess;
  /** Whether the current socket has completed its sync handshake. */
  synced: boolean;
  /** Completed sync handshakes since the provider was created. */
  syncCount: number;
  /** Whether the server has not yet echoed some local change back. */
  hasUnconfirmedChanges: boolean;
  /** The server's reason for refusing the connection, or `null`. */
  refusal: string | null;
  /** The close code of the last socket that closed, or `null`. */
  closeCode: number | null;
}

export type RoomConnectionListener = (state: RoomConnectionState) => void;

export interface ConnectionStateStore {
  get(): RoomConnectionState;
  /** Applies `patch` and notifies the listeners when a field changed. */
  update(patch: Partial<RoomConnectionState>): void;
  subscribe(listener: RoomConnectionListener): () => void;
}

const INITIAL_STATE: RoomConnectionState = Object.freeze({
  status: 'disconnected',
  access: 'pending',
  synced: false,
  syncCount: 0,
  hasUnconfirmedChanges: false,
  refusal: null,
  closeCode: null,
});

/**
 * Reports a listener's error the way the platform reports an event listener's, without stopping the
 * provider's message handling.
 */
export function reportListenerError(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

/** Creates the store behind a provider's {@link RoomConnectionState}. */
export function createConnectionStateStore(): ConnectionStateStore {
  let state = INITIAL_STATE;
  const listeners = new Set<RoomConnectionListener>();

  const update = (patch: Partial<RoomConnectionState>) => {
    const keys = Object.keys(patch) as (keyof RoomConnectionState)[];
    if (keys.every((key) => patch[key] === state[key])) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch (error) {
        reportListenerError(error);
      }
    }
  };

  const subscribe = (listener: RoomConnectionListener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return { get: () => state, update, subscribe };
}
