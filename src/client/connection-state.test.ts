import { describe, expect, it, vi } from 'vitest';
import { createConnectionStateStore } from './connection-state.js';

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
});
