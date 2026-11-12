import type { RoomAccess, RoomSaveStatus } from '../protocol/messages.js';

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
  /**
   * The room's generation, as the server named it when it refused the document for holding
   * another one, or `null`.
   */
  roomGeneration: string | null;
  /** The close code of the last socket that closed, or `null`. */
  closeCode: number | null;
  /** Whether the room has stored its changes, as the server last said on this socket, or `null`. */
  saveStatus: RoomSaveStatus | null;
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
  roomGeneration: null,
  closeCode: null,
  saveStatus: null,
});

/** Where a provider reports errors it catches. */
export interface RoomClientLogger {
  error(message: string, details?: Readonly<Record<string, unknown>>): void;
}

/** Reports an error the provider caught without stopping its message handling. */
export type ErrorReporter = (message: string, error: unknown) => void;

/**
 * Reports to `logger`, or, without one, the way the platform reports an event listener's error:
 * rethrown in a microtask.
 */
export function createErrorReporter(logger: RoomClientLogger | undefined): ErrorReporter {
  if (logger) return (message, error) => logger.error(message, { error });
  return (_message, error) =>
    queueMicrotask(() => {
      throw error;
    });
}

/** Creates the store behind a provider's {@link RoomConnectionState}. */
export function createConnectionStateStore(
  report: ErrorReporter = createErrorReporter(undefined),
): ConnectionStateStore {
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
        report('A connection state listener threw.', error);
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
