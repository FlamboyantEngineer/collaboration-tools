import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { PLATFORM_CLOCK } from '../../protocol/clock.js';
import type { RoomAdmission, RoomAuth, RoomHost, RoomPersistence } from './adapters.js';
import { resolveRoomHost, SILENT_LOGGER } from './host.js';
import { createMemoryPersistence } from './memory-persistence.js';

const auth: RoomAuth = {
  admit: () => Promise.resolve({ ok: false, reason: 'unauthenticated' }),
};

describe('resolveRoomHost', () => {
  it('COLLAB-HOST-1.1 needs only auth and persistence from a host', () => {
    expectTypeOf<RoomHost>().toExtend<{ auth: RoomAuth; persistence: RoomPersistence }>();
    expectTypeOf<RoomAdmission>().toEqualTypeOf<
      | {
          ok: true;
          actor: { id: string; name?: string | undefined };
          access: 'read-write' | 'read-only';
        }
      | { ok: false; reason: 'unauthenticated' | 'forbidden' | 'not-found' }
    >();
  });

  it('COLLAB-HOST-2.1 fills in a silent logger and the platform clock', () => {
    const persistence = createMemoryPersistence();

    const host = resolveRoomHost({ auth, persistence });

    expect(host).toEqual({ auth, persistence, logger: SILENT_LOGGER, clock: PLATFORM_CLOCK });
    expect(() => host.logger.error('ignored', { room: 'room-a' })).not.toThrow();
  });

  it('COLLAB-HOST-2.1 keeps the logger and clock a host passes', () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const clock = { now: () => 5, setTimeout: vi.fn(), clearTimeout: vi.fn() };

    const host = resolveRoomHost({ auth, persistence: createMemoryPersistence(), logger, clock });

    expect(host.logger).toBe(logger);
    expect(host.clock).toBe(clock);
  });

  it('COLLAB-HOST-2.2 schedules and cancels callbacks on the platform clock', () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      const fired = vi.fn();
      const cancelled = vi.fn();

      PLATFORM_CLOCK.setTimeout(fired, 50);
      PLATFORM_CLOCK.clearTimeout(PLATFORM_CLOCK.setTimeout(cancelled, 50));
      vi.advanceTimersByTime(50);

      expect(PLATFORM_CLOCK.now()).toBe(1_050);
      expect(fired).toHaveBeenCalledOnce();
      expect(cancelled).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
