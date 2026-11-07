import { describe, expect, it } from 'vitest';
import { buildRoomUrl, parseRoomUrl } from './room-url.js';

describe('room URLs', () => {
  it('COLLAB-PROTOCOL-2.1 puts the room in one encoded path segment after the endpoint', () => {
    expect(
      buildRoomUrl({
        endpoint: 'wss://host.test/live/?region=eu',
        room: 'a/b c',
        token: 'secret',
        params: { mode: 'edit', token: 'ignored' },
      }),
    ).toBe('wss://host.test/live/a%2Fb%20c?region=eu&mode=edit&token=secret');
  });

  it('COLLAB-PROTOCOL-2.1 leaves the token out when there is none', () => {
    expect(buildRoomUrl({ endpoint: 'ws://host.test', room: 'r', token: null })).toBe(
      'ws://host.test/r',
    );
  });

  it('COLLAB-PROTOCOL-2.2 reads back the room, token, generation and parameters', () => {
    const url = new URL(
      buildRoomUrl({
        endpoint: 'wss://host.test/live',
        room: 'a/b',
        token: 't',
        generation: 'g1',
        params: { mode: 'edit', generation: 'ignored' },
      }),
    );

    expect(url.search).toBe('?mode=edit&generation=g1&token=t');
    expect(parseRoomUrl(url.pathname + url.search)).toEqual({
      room: 'a/b',
      token: 't',
      generation: 'g1',
      params: { mode: 'edit' },
    });
  });

  it('COLLAB-PROTOCOL-2.2 finds no room in an empty or malformed segment', () => {
    expect(parseRoomUrl('/live/')).toBeNull();
    expect(parseRoomUrl('/live/%E0%A4%A')).toBeNull();
    expect(parseRoomUrl('/live/r')).toEqual({
      room: 'r',
      token: null,
      generation: null,
      params: {},
    });
  });
});
