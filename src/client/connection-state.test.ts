import { describe, expect, it, vi } from 'vitest';
import { createConnectionStateStore, createErrorReporter } from './connection-state.js';

describe('createConnectionStateStore', () => {
  it('COLLAB-CLIENT-1.5 notifies only when a field changes', () => {
    const store = createConnectionStateStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.update({ status: 'disconnected' });
    store.update({ status: 'connecting' });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: 'connecting' }));
  });

  it('COLLAB-CLIENT-1.5 keeps notifying after a listener throws, and rethrows its error later', () => {
    const queued: (() => void)[] = [];
    vi.stubGlobal('queueMicrotask', (task: () => void) => queued.push(task));
    const store = createConnectionStateStore();
    const error = new Error('listener failed');
    const after = vi.fn();
    store.subscribe(() => {
      throw error;
    });
    store.subscribe(after);

    store.update({ status: 'connecting' });

    expect(after).toHaveBeenCalledOnce();
    expect(queued).toHaveLength(1);
    expect(() => queued[0]?.()).toThrow(error);
  });

  it('COLLAB-CLIENT-5.4 passes a listener’s error to the provider’s logger when it has one', () => {
    const logger = { error: vi.fn() };
    const store = createConnectionStateStore(createErrorReporter(logger));
    const error = new Error('listener failed');
    store.subscribe(() => {
      throw error;
    });

    store.update({ status: 'connecting' });

    expect(logger.error).toHaveBeenCalledWith('A connection state listener threw.', { error });
  });
});
