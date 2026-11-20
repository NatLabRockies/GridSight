/**
 * Tests for the remote-join input parser. The invariant: whatever a user
 * types, pastes, or scans is routed to the right join path — a scanned
 * /control URL or pasted join code carries its own host+token (cross-env), a
 * 6-digit code is an OTP redeemed against the Host field, and a bare string is
 * a same-backend session key (host field ignored, since it has no ticket).
 *
 * stateBus.js reads `window`/`sessionStorage` at import time (tab-id setup), so
 * we stub the minimum DOM surface before importing — the repo's tests run in
 * the lightweight 'node' environment, not jsdom.
 */
import { describe, it, expect, beforeAll } from 'vitest';

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

let parseJoinInput, parseControlUrl, encodeJoinCode, normalizeHost;

beforeAll(async () => {
  globalThis.window = {
    __gridsightTabIdInitialized__: false,
    opener: null,
    location: {
      origin: 'http://localhost', href: 'http://localhost/', search: '',
      protocol: 'http:', hostname: 'localhost', port: '', host: 'localhost',
      pathname: '/',
    },
    addEventListener: () => {},
    open: () => {},
  };
  globalThis.document = { title: 'test' };
  globalThis.sessionStorage = makeStorage();
  globalThis.localStorage = makeStorage();
  ({ parseJoinInput, parseControlUrl, encodeJoinCode, normalizeHost } =
    await import('../stateBus.js'));
});

describe('parseControlUrl', () => {
  it('extracts host + token from a /control deep link', () => {
    expect(parseControlUrl('https://gridsight.example.org/control/AbC123')).toEqual({
      host: 'https://gridsight.example.org',
      token: 'AbC123',
    });
  });

  it('ignores non-control URLs and junk', () => {
    expect(parseControlUrl('https://gridsight.example.org/dashboard')).toBeNull();
    expect(parseControlUrl('not a url')).toBeNull();
  });
});

describe('parseJoinInput', () => {
  it('routes a scanned /control URL to a cross-env join', () => {
    expect(parseJoinInput('https://wall.example/control/TOK', '')).toEqual({
      kind: 'cross-env', host: 'https://wall.example', token: 'TOK',
    });
  });

  it('routes a pasted join code to a cross-env join', () => {
    const code = encodeJoinCode({ host: 'https://wall.example', token: 'TOK' });
    expect(parseJoinInput(code, '')).toEqual({
      kind: 'cross-env', host: 'https://wall.example', token: 'TOK',
    });
  });

  it('routes a 6-digit code to an OTP redeem against the host field', () => {
    expect(parseJoinInput('123456', 'wall.example')).toEqual({
      kind: 'cross-env', host: 'https://wall.example', otp: '123456',
    });
  });

  it('rejects a 6-digit code with no host', () => {
    expect(parseJoinInput('123456', '')).toBeNull();
  });

  it('treats a bare string as a same-backend session key, ignoring host', () => {
    expect(parseJoinInput('AbCdEfGhI_k', 'wall.example')).toEqual({
      kind: 'session-key', key: 'AbCdEfGhI_k',
    });
  });

  it('returns null for empty input', () => {
    expect(parseJoinInput('', 'wall.example')).toBeNull();
    expect(parseJoinInput('   ', '')).toBeNull();
  });
});

describe('normalizeHost', () => {
  it('adds https:// when no scheme is present', () => {
    expect(normalizeHost('gridsight.example.org')).toBe('https://gridsight.example.org');
  });

  it('preserves an explicit scheme and strips trailing slashes', () => {
    expect(normalizeHost('http://localhost:3001/')).toBe('http://localhost:3001');
  });

  it('returns empty for blank input', () => {
    expect(normalizeHost('  ')).toBe('');
  });
});
