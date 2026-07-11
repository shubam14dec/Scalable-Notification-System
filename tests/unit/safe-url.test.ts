import { describe, test, expect, afterEach, beforeEach } from 'vitest';
import {
  isPrivateIp,
  assertSafeOutboundUrl,
  assertSafeOutboundHost,
  UnsafeOutboundUrlError,
} from '../../src/core/safe-url.js';

// tests/setup.ts allowlists localhost for the integration suites; these
// unit tests exercise the guard itself, so they start from an empty list.
const savedAllow = process.env.OUTBOUND_URL_ALLOW;
beforeEach(() => {
  process.env.OUTBOUND_URL_ALLOW = '';
});
afterEach(() => {
  process.env.OUTBOUND_URL_ALLOW = savedAllow;
});

describe('isPrivateIp', () => {
  const privates = [
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '198.18.0.1', // benchmarking
    '0.0.0.0',
    '224.0.0.1', // multicast
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1', // ULA
    'fd12:3456::1',
    'fe80::1', // link-local
    'ff02::1', // multicast
    '::ffff:127.0.0.1', // v4-mapped loopback
    '::ffff:192.168.0.1', // v4-mapped private
  ];
  for (const ip of privates) {
    test(`${ip} is private`, () => expect(isPrivateIp(ip)).toBe(true));
  }

  const publics = [
    '8.8.8.8',
    '1.1.1.1',
    '172.15.0.1', // just below 172.16/12
    '172.32.0.1', // just above 172.16/12
    '100.128.0.1', // just above CGNAT
    '198.20.0.1', // just above 198.18/15
    '2606:4700::1111', // cloudflare v6
    '::ffff:8.8.8.8', // v4-mapped public
  ];
  for (const ip of publics) {
    test(`${ip} is public`, () => expect(isPrivateIp(ip)).toBe(false));
  }

  test('non-IP input fails closed', () => expect(isPrivateIp('not-an-ip')).toBe(true));
});

describe('assertSafeOutboundUrl (resolve: false)', () => {
  const rejects = async (url: string) =>
    expect(assertSafeOutboundUrl(url, { resolve: false })).rejects.toBeInstanceOf(
      UnsafeOutboundUrlError,
    );
  const accepts = async (url: string) =>
    expect(assertSafeOutboundUrl(url, { resolve: false })).resolves.toBeUndefined();

  test('rejects private literal IPs', async () => {
    await rejects('http://127.0.0.1:4100/agent');
    await rejects('http://169.254.169.254/latest/meta-data/');
    await rejects('http://192.168.1.1/');
    await rejects('http://[::1]:8080/');
  });

  test('rejects localhost and internal-style hostnames', async () => {
    await rejects('http://localhost:4100/');
    await rejects('http://foo.localhost/');
    await rejects('http://redis.local/');
    await rejects('http://db.internal/');
    await rejects('http://nas.home.arpa/');
  });

  test('rejects non-http schemes and embedded credentials', async () => {
    await rejects('ftp://example.com/file');
    await rejects('file:///etc/passwd');
    await rejects('http://user:pass@example.com/');
    await rejects('not a url');
  });

  test('accepts public https and http URLs', async () => {
    await accepts('https://example.com/webhook');
    await accepts('http://example.com:8080/bridge');
    await accepts('https://8.8.8.8/x');
  });

  test('OUTBOUND_URL_ALLOW exempts exact hostnames only', async () => {
    process.env.OUTBOUND_URL_ALLOW = 'localhost,127.0.0.1';
    await accepts('http://localhost:4100/');
    await accepts('http://127.0.0.1:4100/');
    await rejects('http://192.168.1.1/'); // not allowlisted
    await rejects('http://evil-localhost.example.localhost/'); // suffix, not exact
  });
});

describe('assertSafeOutboundHost', () => {
  test('rejects private hosts, accepts public, honors allowlist', async () => {
    await expect(
      assertSafeOutboundHost('127.0.0.1', { resolve: false }),
    ).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
    await expect(
      assertSafeOutboundHost('localhost', { resolve: false }),
    ).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
    await expect(
      assertSafeOutboundHost('smtp.example.com', { resolve: false }),
    ).resolves.toBeUndefined();
    process.env.OUTBOUND_URL_ALLOW = 'localhost';
    await expect(
      assertSafeOutboundHost('localhost', { resolve: false }),
    ).resolves.toBeUndefined();
  });
});
