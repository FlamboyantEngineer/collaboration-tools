import { encodeStorageMessage } from '../protocol/messages.js';

/**
 * A provider's open receipt requests. A request goes out once the socket has synced, so every
 * local change made before it, those resent after a reconnect included, reaches the server first.
 */
export interface StoreReceipts {
  /** Opens a request; it resolves `true` with its receipt, or `false` once the receipts end. */
  request(): Promise<boolean>;
  /** Sends every request the current socket has not carried yet. */
  sendPending(send: (frame: Uint8Array<ArrayBuffer>) => boolean): void;
  /** Resolves the request a receipt answers. */
  received(id: number): void;
  /** The socket closed: every open request goes out again on the next one. */
  resend(): void;
  /** Resolves every open request `false`. */
  end(): void;
}

interface OpenRequest {
  sent: boolean;
  resolve(stored: boolean): void;
}

export function createStoreReceipts(): StoreReceipts {
  const open = new Map<number, OpenRequest>();
  let nextId = 0;

  return {
    request: () =>
      new Promise((resolve) => {
        nextId += 1;
        open.set(nextId, { sent: false, resolve });
      }),
    sendPending: (send) => {
      for (const [id, request] of open) {
        if (!request.sent)
          request.sent = send(encodeStorageMessage({ type: 'receipt-request', id }));
      }
    },
    received: (id) => {
      open.get(id)?.resolve(true);
      open.delete(id);
    },
    resend: () => {
      for (const request of open.values()) request.sent = false;
    },
    end: () => {
      for (const request of open.values()) request.resolve(false);
      open.clear();
    },
  };
}
