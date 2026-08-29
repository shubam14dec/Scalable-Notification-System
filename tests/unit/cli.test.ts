/**
 * @asyncify-hq/cli unit tests: the four pure modules that the CLI is built on —
 * argument parsing, cloudflared URL extraction, .env line rewriting, webhook
 * rewire planning, and the tunnel watchdog state machine. Imported straight out
 * of packages/cli/src the same way the agent SDK tests import packages/agent/src.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { parseArgs, SEED_API_KEY } from '../../packages/cli/src/args';
import {
  parseTunnelUrl,
  PublicDnsUnavailableError,
  resolvePublicA,
  waitForTunnelReady,
} from '../../packages/cli/src/tunnel';
import { rewritePublicUrlLine } from '../../packages/cli/src/env-file';
import { planRewire, type Connection } from '../../packages/cli/src/rewire';
import { initWatchdogState, tick, type WdEvent, type WdState } from '../../packages/cli/src/watchdog';

// argv shape is the full process.argv: [node, script, command, ...rest].
const argv = (...parts: string[]): string[] => ['node', 'asyncify', ...parts];

describe('parseArgs: dev', () => {
  // parseDev consults process.env.ASYNCIFY_API_KEY and ASYNCIFY_WAIT for its
  // fallbacks, so we restore both around every test that depends on them.
  const savedEnvKey = process.env.ASYNCIFY_API_KEY;
  const savedEnvWait = process.env.ASYNCIFY_WAIT;
  afterEach(() => {
    if (savedEnvKey === undefined) delete process.env.ASYNCIFY_API_KEY;
    else process.env.ASYNCIFY_API_KEY = savedEnvKey;
    if (savedEnvWait === undefined) delete process.env.ASYNCIFY_WAIT;
    else process.env.ASYNCIFY_WAIT = savedEnvWait;
  });

  test('dev with no flags → defaults, seed key when no env key', () => {
    delete process.env.ASYNCIFY_API_KEY;
    delete process.env.ASYNCIFY_WAIT;
    const args = parseArgs(argv('dev'));
    expect(args).toEqual({
      command: 'dev',
      port: 3000,
      apiUrl: 'http://localhost:3000',
      apiKey: SEED_API_KEY,
      apiKeyIsSeedDefault: true,
      envWrite: true,
      // The reachability gate's budget: 5 minutes, in ms.
      waitMs: 300_000,
    });
  });

  test('dev --wait <seconds> becomes waitMs in milliseconds', () => {
    const args = parseArgs(argv('dev', '--wait', '600'));
    if (args.command === 'dev') expect(args.waitMs).toBe(600_000);
  });

  test('dev picks up ASYNCIFY_WAIT when no flag given; the flag wins over it', () => {
    process.env.ASYNCIFY_WAIT = '120';
    const fromEnv = parseArgs(argv('dev'));
    if (fromEnv.command === 'dev') expect(fromEnv.waitMs).toBe(120_000);
    const fromFlag = parseArgs(argv('dev', '--wait', '45'));
    if (fromFlag.command === 'dev') expect(fromFlag.waitMs).toBe(45_000);
  });

  test('dev --wait without a value throws', () => {
    expect(() => parseArgs(argv('dev', '--wait'))).toThrow(/--wait requires a value/);
  });

  test('dev --wait with a non-integer throws', () => {
    expect(() => parseArgs(argv('dev', '--wait', '2m'))).toThrow(/--wait expects an integer/);
  });

  test('dev --wait outside 5-3600 seconds throws naming the range', () => {
    expect(() => parseArgs(argv('dev', '--wait', '2'))).toThrow(
      /--wait expects 5-3600 seconds, got "2"/,
    );
    expect(() => parseArgs(argv('dev', '--wait', '99999'))).toThrow(/expects 5-3600 seconds/);
  });

  test('a bad ASYNCIFY_WAIT is rejected naming the env var, not the flag', () => {
    delete process.env.ASYNCIFY_API_KEY;
    process.env.ASYNCIFY_WAIT = 'soon';
    expect(() => parseArgs(argv('dev'))).toThrow(/ASYNCIFY_WAIT expects an integer/);
  });

  test('dev --port sets the port (integer-validated)', () => {
    const args = parseArgs(argv('dev', '--port', '4000'));
    expect(args.command).toBe('dev');
    if (args.command === 'dev') expect(args.port).toBe(4000);
  });

  test('dev --api-url overrides the API base', () => {
    const args = parseArgs(argv('dev', '--api-url', 'https://api.asyncify.test'));
    if (args.command === 'dev') expect(args.apiUrl).toBe('https://api.asyncify.test');
  });

  test('dev --api-key wins and clears the seed-default flag', () => {
    delete process.env.ASYNCIFY_API_KEY;
    const args = parseArgs(argv('dev', '--api-key', 'tenant-key-xyz'));
    if (args.command === 'dev') {
      expect(args.apiKey).toBe('tenant-key-xyz');
      expect(args.apiKeyIsSeedDefault).toBe(false);
    }
  });

  test('dev picks up ASYNCIFY_API_KEY from env when no flag given', () => {
    process.env.ASYNCIFY_API_KEY = 'env-provided-key';
    const args = parseArgs(argv('dev'));
    if (args.command === 'dev') {
      expect(args.apiKey).toBe('env-provided-key');
      expect(args.apiKeyIsSeedDefault).toBe(false);
    }
  });

  test('dev --no-env-write disables the ./.env write', () => {
    const args = parseArgs(argv('dev', '--no-env-write'));
    if (args.command === 'dev') expect(args.envWrite).toBe(false);
  });

  test('dev --port without a value throws', () => {
    expect(() => parseArgs(argv('dev', '--port'))).toThrow(/--port requires a value/);
  });

  test('dev --port with a non-integer throws', () => {
    expect(() => parseArgs(argv('dev', '--port', '3000x'))).toThrow(/expects an integer/);
  });

  test('dev with an unknown flag throws naming the flag', () => {
    expect(() => parseArgs(argv('dev', '--bogus'))).toThrow(/unknown flag: --bogus/);
  });
});

describe('parseArgs: create-agent', () => {
  test('create-agent <dir> → identifier defaults to slugified basename', () => {
    const args = parseArgs(argv('create-agent', './My Bot Dir'));
    expect(args).toEqual({
      command: 'create-agent',
      dir: './My Bot Dir',
      identifier: 'my-bot-dir',
    });
  });

  test('create-agent --identifier overrides and is slugified', () => {
    const args = parseArgs(argv('create-agent', './bot', '--identifier', 'Support Bot!'));
    if (args.command === 'create-agent') {
      expect(args.dir).toBe('./bot');
      expect(args.identifier).toBe('support-bot');
    }
  });

  test('create-agent with no directory throws', () => {
    expect(() => parseArgs(argv('create-agent'))).toThrow(/requires a target directory/);
  });

  test('create-agent --identifier without a value throws', () => {
    expect(() => parseArgs(argv('create-agent', './bot', '--identifier'))).toThrow(
      /--identifier requires a value/,
    );
  });

  test('create-agent with an unknown flag throws naming the flag', () => {
    expect(() => parseArgs(argv('create-agent', './bot', '--wat'))).toThrow(/unknown flag: --wat/);
  });
});

describe('parseArgs: dispatch', () => {
  test('an unknown command throws naming the command', () => {
    expect(() => parseArgs(argv('deploy'))).toThrow(/unknown command: deploy/);
  });

  test('no command at all throws with (none)', () => {
    expect(() => parseArgs(['node', 'asyncify'])).toThrow(/unknown command: \(none\)/);
  });
});

describe('parseTunnelUrl', () => {
  test('extracts the tunnel URL from a single chunk', () => {
    const buf =
      '2024-01-01 INF +----------------------+\n' +
      '2024-01-01 INF |  https://happy-tree-42.trycloudflare.com  |\n' +
      '2024-01-01 INF +----------------------+\n';
    expect(parseTunnelUrl(buf)).toBe('https://happy-tree-42.trycloudflare.com');
  });

  test('a URL split across two appended chunks: partial → null, full → match', () => {
    // cloudflared streams stderr; a rolling buffer can hold half a URL first.
    const partial = '2024 INF Your quick Tunnel has been created! https://cold-';
    expect(parseTunnelUrl(partial)).toBeNull();
    const full = partial + 'bird-99.trycloudflare.com\n2024 INF done';
    expect(parseTunnelUrl(full)).toBe('https://cold-bird-99.trycloudflare.com');
  });

  test('skips the api.trycloudflare.com host that appears before the real URL', () => {
    const buf =
      '2024 INF Requesting new quick Tunnel on https://api.trycloudflare.com/tunnel ...\n' +
      '2024 INF Connection registered\n' +
      '2024 INF +--------------------------------------+\n' +
      '2024 INF |  https://misty-forest-7.trycloudflare.com  |\n';
    expect(parseTunnelUrl(buf)).toBe('https://misty-forest-7.trycloudflare.com');
  });

  test('returns null when no tunnel URL is present', () => {
    expect(parseTunnelUrl('2024 INF connecting...\n2024 INF still connecting\n')).toBeNull();
  });
});

describe('rewritePublicUrlLine', () => {
  test('replaces an existing PUBLIC_URL line, leaving other lines untouched', () => {
    const before = 'FOO=1\nPUBLIC_URL=http://old\nBAR=2\n';
    expect(rewritePublicUrlLine(before, 'https://new.example')).toBe(
      'FOO=1\nPUBLIC_URL=https://new.example\nBAR=2\n',
    );
  });

  test('appends PUBLIC_URL when absent, preserving comments byte-for-byte', () => {
    const before = '# my env\nFOO=1\n';
    expect(rewritePublicUrlLine(before, 'https://new.example')).toBe(
      '# my env\nFOO=1\nPUBLIC_URL=https://new.example\n',
    );
  });

  test('a CRLF file stays CRLF byte-for-byte (replace)', () => {
    const before = 'FOO=1\r\nPUBLIC_URL=http://old\r\nBAR=2\r\n';
    const after = rewritePublicUrlLine(before, 'https://new.example');
    expect(after).toBe('FOO=1\r\nPUBLIC_URL=https://new.example\r\nBAR=2\r\n');
  });

  test('a CRLF file stays CRLF when appending', () => {
    const before = 'FOO=1\r\nBAR=2\r\n';
    const after = rewritePublicUrlLine(before, 'https://new.example');
    expect(after).toBe('FOO=1\r\nBAR=2\r\nPUBLIC_URL=https://new.example\r\n');
  });

  test('an LF file stays LF byte-for-byte', () => {
    const before = 'FOO=1\nPUBLIC_URL=http://old\n';
    const after = rewritePublicUrlLine(before, 'https://new.example');
    expect(after).toBe('FOO=1\nPUBLIC_URL=https://new.example\n');
    expect(after.includes('\r')).toBe(false);
  });

  test('idempotent: applying twice with the same url yields identical output', () => {
    const before = 'FOO=1\nPUBLIC_URL=http://old\nBAR=2\n';
    const once = rewritePublicUrlLine(before, 'https://new.example');
    const twice = rewritePublicUrlLine(once, 'https://new.example');
    expect(twice).toBe(once);
  });
});

describe('planRewire', () => {
  function tg(id: string, status: string): Connection {
    return {
      id,
      channel: 'telegram',
      status,
      config: { botUsername: `bot_${id}` },
      agent: { identifier: `a-${id}`, name: `Agent ${id}` },
      webhook: { url: 'https://x/hook', expectedUrl: `https://x/webhooks/telegram/${id}` },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  }
  function slack(id: string, status: string): Connection {
    return {
      id,
      channel: 'slack',
      status,
      config: { teamName: 'Team' },
      agent: { identifier: `a-${id}`, name: `Agent ${id}` },
      webhook: {
        eventsUrl: `https://x/webhooks/slack/${id}/events`,
        interactivityUrl: `https://x/webhooks/slack/${id}/interactivity`,
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  }
  function email(id: string, status: string): Connection {
    return {
      id,
      channel: 'email',
      status,
      config: { address: `${id}@inbound.test` },
      agent: { identifier: `a-${id}`, name: `Agent ${id}` },
      webhook: { url: `https://x/webhooks/email/${id}?key=s` },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  }

  test('active telegram → reconnectIds; inactive telegram → excluded', () => {
    const plan = planRewire([tg('t1', 'active'), tg('t2', 'inactive')], null);
    expect(plan.reconnectIds).toEqual(['t1']);
    expect(plan.pasteRows).toEqual([]);
  });

  test('slack yields two paste rows and email one, even when inactive', () => {
    const plan = planRewire([slack('s1', 'inactive'), email('e1', 'inactive')], null);
    expect(plan.reconnectIds).toEqual([]);
    expect(plan.pasteRows.map((r) => r.key)).toEqual([
      's1:slack-events',
      's1:slack-interactivity',
      'e1:email',
    ]);
  });

  test('first run (prevUrls null) marks every paste row changed', () => {
    const plan = planRewire([slack('s1', 'active'), email('e1', 'active')], null);
    expect(plan.pasteRows.every((r) => r.changed)).toBe(true);
  });

  test('changed is false when the URL matches the previous snapshot, true when it differs', () => {
    const prev = new Map<string, string>([
      ['s1:slack-events', 'https://x/webhooks/slack/s1/events'],
      ['s1:slack-interactivity', 'https://OLD/webhooks/slack/s1/interactivity'],
      ['e1:email', 'https://x/webhooks/email/e1?key=s'],
    ]);
    const plan = planRewire([slack('s1', 'active'), email('e1', 'active')], prev);
    const byKey = Object.fromEntries(plan.pasteRows.map((r) => [r.key, r.changed]));
    expect(byKey['s1:slack-events']).toBe(false); // same as snapshot
    expect(byKey['s1:slack-interactivity']).toBe(true); // differs from snapshot
    expect(byKey['e1:email']).toBe(false); // same as snapshot
  });
});

// ---------------------------------------------------------------------------
// Phase A15 — the reachability gate now asks PUBLIC DNS.
//
// A poll is: resolve the host on 1.1.1.1 (then 8.8.8.8), then HTTPS-probe
// /health at that IP with SNI+Host pinned to the hostname. Only when NO public
// resolver answers at all does the poll degrade to the original plain-fetch
// probe. Every dependency is injected; no test touches the network or a clock.
// ---------------------------------------------------------------------------

/** A DNS error carrying a c-ares style code, as node's Resolver rejects with. */
function dnsError(code: string): NodeJS.ErrnoException {
  const err = new Error(`queryA ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/**
 * A resolver over a queued sequence of answers, recording (host, server) pairs.
 * An entry is an address list, or a code string to reject with.
 */
function fakeResolver(sequence: Array<string[] | string>) {
  let i = 0;
  const calls: Array<{ host: string; server: string }> = [];
  const fn = async (host: string, server: string): Promise<string[]> => {
    calls.push({ host, server });
    const answer = sequence[Math.min(i, sequence.length - 1)];
    i += 1;
    if (typeof answer === 'string') throw dnsError(answer);
    return answer;
  };
  return { fn, calls };
}

/** A resolver that is never reachable — every server times out. */
const deadResolvers = async (): Promise<string[]> => {
  throw dnsError('ETIMEOUT');
};

// A sleep that never really waits; just counts invocations so we can assert
// how many poll intervals elapsed.
function fakeSleep() {
  const waits: number[] = [];
  const fn = (ms: number) => {
    waits.push(ms);
    return Promise.resolve();
  };
  return { fn, waits };
}

describe('resolvePublicA', () => {
  test('returns the first IPv4 from the first resolver that answers', async () => {
    const { fn, calls } = fakeResolver([['104.21.0.7', '172.67.0.9']]);
    await expect(resolvePublicA('t.trycloudflare.com', { resolveFn: fn })).resolves.toBe(
      '104.21.0.7',
    );
    // Only 1.1.1.1 was consulted; 8.8.8.8 is a fallback, not a second opinion.
    expect(calls).toEqual([{ host: 't.trycloudflare.com', server: '1.1.1.1' }]);
  });

  test('NXDOMAIN is an ANSWER (null), not a resolver failure — no fallback query', async () => {
    const { fn, calls } = fakeResolver(['ENOTFOUND']);
    await expect(resolvePublicA('nope.trycloudflare.com', { resolveFn: fn })).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  test('an empty answer is also null', async () => {
    const { fn } = fakeResolver([[]]);
    await expect(resolvePublicA('t.example', { resolveFn: fn })).resolves.toBeNull();
  });

  test('when 1.1.1.1 errors, 8.8.8.8 is used and its answer wins', async () => {
    const { fn, calls } = fakeResolver(['ETIMEOUT', ['8.8.4.4']]);
    await expect(resolvePublicA('t.example', { resolveFn: fn })).resolves.toBe('8.8.4.4');
    expect(calls.map((c) => c.server)).toEqual(['1.1.1.1', '8.8.8.8']);
  });

  test('when every resolver errors it throws PublicDnsUnavailableError naming the host', async () => {
    const { fn, calls } = fakeResolver(['ECONNREFUSED']);
    await expect(resolvePublicA('t.example', { resolveFn: fn })).rejects.toThrow(
      PublicDnsUnavailableError,
    );
    expect(calls.map((c) => c.server)).toEqual(['1.1.1.1', '8.8.8.8']);
  });
});

describe('waitForTunnelReady: public-DNS path', () => {
  /** A pinned probe over a queued sequence of booleans; records (url, ip). */
  function fakeProbe(sequence: boolean[]) {
    let i = 0;
    const calls: Array<{ url: string; ip: string }> = [];
    const fn = async (url: string, ip: string): Promise<boolean> => {
      calls.push({ url, ip });
      const ok = sequence[Math.min(i, sequence.length - 1)];
      i += 1;
      return ok;
    };
    return { fn, calls };
  }

  test('an A record on the first try → pinned probes → resolves on the streak', async () => {
    const { fn: resolveFn } = fakeResolver([['104.21.0.7']]);
    const { fn: pinnedProbeFn, calls } = fakeProbe([true]);
    const { fn: sleepFn, waits } = fakeSleep();
    const lines: string[] = [];

    await expect(
      waitForTunnelReady('https://t.example', {
        resolveFn,
        pinnedProbeFn,
        sleepFn,
        consecutive: 2,
        maxWaitMs: 60_000,
        intervalMs: 2_000,
        onProgress: (l) => lines.push(l),
      }),
    ).resolves.toBeUndefined();

    // Two pinned probes, both dialing the address public DNS handed us.
    expect(calls).toEqual([
      { url: 'https://t.example', ip: '104.21.0.7' },
      { url: 'https://t.example', ip: '104.21.0.7' },
    ]);
    expect(waits).toEqual([2_000]);
    expect(lines.some((l) => l.includes('104.21.0.7'))).toBe(true);
    expect(lines.some((l) => l.includes('answered its first health check'))).toBe(true);
    // Transitions only: each line is said once, never per poll.
    expect(new Set(lines).size).toBe(lines.length);
  });

  test('NXDOMAIN for a while, then the record appears — elapsed accounting is by sleeps', async () => {
    // 3 polls with no record, then the address shows up and answers twice.
    const { fn: resolveFn } = fakeResolver([
      'ENOTFOUND',
      'ENOTFOUND',
      'ENOTFOUND',
      ['104.21.0.7'],
    ]);
    const { fn: pinnedProbeFn, calls } = fakeProbe([true]);
    const { fn: sleepFn, waits } = fakeSleep();

    await waitForTunnelReady('https://t.example', {
      resolveFn,
      pinnedProbeFn,
      sleepFn,
      consecutive: 2,
      maxWaitMs: 60_000,
      intervalMs: 2_000,
    });

    // No pinned probe is attempted while the name does not resolve.
    expect(calls).toHaveLength(2);
    // 5 polls total → 4 sleeps → 8s of budget spent.
    expect(waits).toEqual([2_000, 2_000, 2_000, 2_000]);
  });

  test('a failed pinned probe resets the streak even though DNS resolves', async () => {
    const { fn: resolveFn } = fakeResolver([['104.21.0.7']]);
    const { fn: pinnedProbeFn, calls } = fakeProbe([true, false, true, true]);
    const { fn: sleepFn } = fakeSleep();

    await waitForTunnelReady('https://t.example', {
      resolveFn,
      pinnedProbeFn,
      sleepFn,
      consecutive: 2,
      maxWaitMs: 60_000,
      intervalMs: 2_000,
    });
    expect(calls).toHaveLength(4);
  });

  test('rejects after maxWaitMs with a message naming the URL', async () => {
    const { fn: resolveFn } = fakeResolver(['ENOTFOUND']);
    const { fn: pinnedProbeFn, calls } = fakeProbe([true]);
    const { fn: sleepFn, waits } = fakeSleep();

    await expect(
      waitForTunnelReady('https://never.example', {
        resolveFn,
        pinnedProbeFn,
        sleepFn,
        consecutive: 2,
        maxWaitMs: 6_000,
        intervalMs: 2_000,
      }),
    ).rejects.toThrow(/never became publicly reachable[\s\S]*https:\/\/never\.example/);
    expect(calls).toHaveLength(0);
    expect(waits).toEqual([2_000, 2_000, 2_000]);
  });

  test('a long wait emits a progress heartbeat roughly every 30s, not every poll', async () => {
    const { fn: resolveFn } = fakeResolver(['ENOTFOUND']);
    const { fn: sleepFn } = fakeSleep();
    const lines: string[] = [];

    await expect(
      waitForTunnelReady('https://slow.example', {
        resolveFn,
        pinnedProbeFn: async () => false,
        sleepFn,
        consecutive: 2,
        maxWaitMs: 90_000,
        intervalMs: 10_000,
        onProgress: (l) => lines.push(l),
      }),
    ).rejects.toThrow(/never became publicly reachable/);

    // 9 polls, but only the 30/60/90s marks speak up.
    const heartbeats = lines.filter((l) => l.includes('still waiting'));
    expect(heartbeats).toHaveLength(3);
    expect(heartbeats[0]).toContain('30s of 90s');
  });
});

// The original gate's behaviour, preserved verbatim as the fallback path: when
// NO public resolver can be reached (corporate networks block outbound DNS), a
// poll degrades to the plain `fetch` probe it always used. These four tests are
// the pre-A15 suite with one addition — a resolver that is never reachable —
// so they prove the gate is never WORSE than it was.
describe('waitForTunnelReady: system-fetch fallback (no public resolver reachable)', () => {
  // A fake fetch that returns a queued sequence of outcomes. `true` → ok:true,
  // `false` → ok:false, 'throw' → rejects (mirrors a DNS/connection error).
  // Records how many times it was called.
  function fakeFetch(sequence: Array<boolean | 'throw'>) {
    let i = 0;
    const calls: string[] = [];
    const fn = (async (input: string) => {
      calls.push(input);
      const outcome = sequence[Math.min(i, sequence.length - 1)];
      i += 1;
      if (outcome === 'throw') throw new Error('connect ECONNREFUSED');
      return { ok: outcome } as Response;
    }) as unknown as typeof fetch;
    return { fn, calls };
  }

  test('resolves after `consecutive` successes in a row', async () => {
    const { fn: fetchFn, calls } = fakeFetch([true, true]);
    const { fn: sleepFn } = fakeSleep();
    const lines: string[] = [];
    await expect(
      waitForTunnelReady('https://t.example', {
        fetchFn,
        resolveFn: deadResolvers,
        sleepFn,
        consecutive: 2,
        maxWaitMs: 60_000,
        intervalMs: 2_000,
        onProgress: (l) => lines.push(l),
      }),
    ).resolves.toBeUndefined();
    // Polls health twice (two successes), no third poll after the streak is met.
    expect(calls).toEqual(['https://t.example/health', 'https://t.example/health']);
    // The degradation is announced exactly once, not once per poll.
    expect(lines.filter((l) => l.includes('no public DNS server is reachable'))).toHaveLength(1);
  });

  test('a failure between successes resets the streak', async () => {
    // ok, fail, ok, ok → only the last two are consecutive, so 4 polls total.
    const { fn: fetchFn, calls } = fakeFetch([true, false, true, true]);
    const { fn: sleepFn, waits } = fakeSleep();
    await waitForTunnelReady('https://t.example', {
      fetchFn,
      resolveFn: deadResolvers,
      sleepFn,
      consecutive: 2,
      maxWaitMs: 60_000,
      intervalMs: 2_000,
    });
    expect(calls).toHaveLength(4);
    // Three sleeps between the four polls.
    expect(waits).toEqual([2_000, 2_000, 2_000]);
  });

  test('a thrown fetch error counts as a failure and resets the streak', async () => {
    // ok, throw, ok, ok → 4 polls, resolves on the final consecutive pair.
    const { fn: fetchFn, calls } = fakeFetch([true, 'throw', true, true]);
    const { fn: sleepFn } = fakeSleep();
    await waitForTunnelReady('https://t.example', {
      fetchFn,
      resolveFn: deadResolvers,
      sleepFn,
      consecutive: 2,
      maxWaitMs: 60_000,
      intervalMs: 2_000,
    });
    expect(calls).toHaveLength(4);
  });

  test('rejects after maxWaitMs of budget with a message naming the URL', async () => {
    // Never healthy. Budget of 6s at 2s intervals allows polls at elapsed
    // 0, 2s, 4s; the check at elapsed 6s (>= max) throws instead of sleeping.
    const { fn: fetchFn, calls } = fakeFetch([false]);
    const { fn: sleepFn, waits } = fakeSleep();
    await expect(
      waitForTunnelReady('https://never.example', {
        fetchFn,
        resolveFn: deadResolvers,
        sleepFn,
        consecutive: 2,
        maxWaitMs: 6_000,
        intervalMs: 2_000,
      }),
    ).rejects.toThrow(/never became publicly reachable[\s\S]*https:\/\/never\.example/);
    // 4 polls (elapsed 0/2k/4k/6k), 3 sleeps before the deadline is hit.
    expect(calls).toHaveLength(4);
    expect(waits).toEqual([2_000, 2_000, 2_000]);
  });
});

describe('watchdog tick', () => {
  // Thread state through a sequence of events, collecting the actions.
  function run(events: WdEvent[], start: WdState = initWatchdogState()) {
    let state = start;
    const actions = events.map((e) => {
      const res = tick(state, e);
      state = res.state;
      return res.action;
    });
    return { state, actions };
  }

  test('health_ok resets the failure count (2 fails + ok + 2 fails → no rotate)', () => {
    const { actions } = run([
      { kind: 'health_fail', at: 1 },
      { kind: 'health_fail', at: 2 },
      { kind: 'health_ok', at: 3 },
      { kind: 'health_fail', at: 4 },
      { kind: 'health_fail', at: 5 },
    ]);
    expect(actions).toEqual(['none', 'none', 'none', 'none', 'none']);
  });

  test('the 3rd consecutive health_fail triggers a rotate and resets the counter', () => {
    const { actions, state } = run([
      { kind: 'health_fail', at: 1 },
      { kind: 'health_fail', at: 2 },
      { kind: 'health_fail', at: 3 },
    ]);
    expect(actions).toEqual(['none', 'none', 'rotate']);
    expect(state.failures).toBe(0);
  });

  test('child_exit rotates immediately even with zero prior failures', () => {
    const { actions } = run([{ kind: 'child_exit', at: 100 }]);
    expect(actions).toEqual(['rotate']);
  });

  test('clock_jump yields check_now', () => {
    const { actions } = run([{ kind: 'clock_jump', at: 100 }]);
    expect(actions).toEqual(['check_now']);
  });

  test('the 5th rotation within 120s returns pause with pausedUntil = at + 60s', () => {
    const events: WdEvent[] = [
      { kind: 'child_exit', at: 1_000 },
      { kind: 'child_exit', at: 2_000 },
      { kind: 'child_exit', at: 3_000 },
      { kind: 'child_exit', at: 4_000 },
      { kind: 'child_exit', at: 5_000 },
    ];
    const { actions, state } = run(events);
    expect(actions).toEqual(['rotate', 'rotate', 'rotate', 'rotate', 'pause']);
    expect(state.pausedUntil).toBe(5_000 + 60_000);
  });

  test('while paused, health_fail and child_exit are swallowed as none (incl. at == pausedUntil)', () => {
    // Reach the pause first.
    const paused = run([
      { kind: 'child_exit', at: 1_000 },
      { kind: 'child_exit', at: 2_000 },
      { kind: 'child_exit', at: 3_000 },
      { kind: 'child_exit', at: 4_000 },
      { kind: 'child_exit', at: 5_000 },
    ]).state;
    expect(paused.pausedUntil).toBe(65_000);

    const { actions } = run(
      [
        { kind: 'health_fail', at: 6_000 },
        { kind: 'child_exit', at: 40_000 },
        { kind: 'clock_jump', at: 65_000 }, // exactly at pausedUntil → still suppressed
      ],
      paused,
    );
    expect(actions).toEqual(['none', 'none', 'none']);
  });

  test('an event after pausedUntil resumes normal handling', () => {
    const paused = run([
      { kind: 'child_exit', at: 1_000 },
      { kind: 'child_exit', at: 2_000 },
      { kind: 'child_exit', at: 3_000 },
      { kind: 'child_exit', at: 4_000 },
      { kind: 'child_exit', at: 5_000 },
    ]).state;

    // clock_jump just past the pause window → suppression lifts, normal action.
    const resumed = tick(paused, { kind: 'clock_jump', at: 65_001 });
    expect(resumed.action).toBe('check_now');
    expect(resumed.state.pausedUntil).toBeNull();

    // And once the old rotations age out of the 120s window, a rotate is a
    // plain rotate again (not an instant re-pause).
    const afterWindow = tick(resumed.state, { kind: 'child_exit', at: 200_000 });
    expect(afterWindow.action).toBe('rotate');
  });

  test('rotations spaced more than 120s apart never accumulate to a pause', () => {
    const events: WdEvent[] = [0, 130_000, 260_000, 390_000, 520_000, 650_000].map((at) => ({
      kind: 'child_exit',
      at,
    }));
    const { actions } = run(events);
    expect(actions).toEqual(['rotate', 'rotate', 'rotate', 'rotate', 'rotate', 'rotate']);
  });
});

// ---------------------------------------------------------------------------
// Phase 17 Slice E — CLI slack auto-update (runtime-attempt model).
//
// planRewire now sends ACTIVE and PENDING slack connections to a new
// `slackAttemptIds` list (runRewire POSTs …/reconnect for each and, on a 200,
// drops that connection's paste rows). Pending is included because a
// quick-setup app created but not yet installed already holds a refresh
// chain, and a rotation before install strands its redirect/event URLs.
// Paste rows carry `connectionId` so the runner can match them. These tests
// cover the PURE plan output only.
//
// runRewire's effects (the slack attempt loop, success suppression, and the
// refresh-expired hint line) are NOT unit-tested here: runRewire calls the
// module-level `apiFetch` from ./api, which is not injectable through its ctx
// (ctx exposes only log/sleep). Testing those paths would require module
// mocking of ./api, which this slice deliberately avoids — so the behavior is
// covered by the plan assertions below plus the integration surface.
// ---------------------------------------------------------------------------
describe('planRewire: slack runtime-attempt model (Phase 17 Slice E)', () => {
  function slackConn(id: string, status: string): Connection {
    return {
      id,
      channel: 'slack',
      status,
      config: { teamName: `Team ${id}` },
      agent: { identifier: `a-${id}`, name: `Agent ${id}` },
      webhook: {
        eventsUrl: `https://x/webhooks/slack/${id}/events`,
        interactivityUrl: `https://x/webhooks/slack/${id}/interactivity`,
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  }
  function tgConn(id: string, status: string): Connection {
    return {
      id,
      channel: 'telegram',
      status,
      config: { botUsername: `bot_${id}` },
      agent: { identifier: `a-${id}`, name: `Agent ${id}` },
      webhook: { url: 'https://x/hook', expectedUrl: `https://x/webhooks/telegram/${id}` },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  }
  function emailConn(id: string, status: string): Connection {
    return {
      id,
      channel: 'email',
      status,
      config: { address: `${id}@inbound.test` },
      agent: { identifier: `a-${id}`, name: `Agent ${id}` },
      webhook: { url: `https://x/webhooks/email/${id}?key=s` },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  }

  test('active slack → slackAttemptIds AND still emits its two paste rows', () => {
    const plan = planRewire([slackConn('s1', 'active')], null);
    expect(plan.slackAttemptIds).toEqual(['s1']);
    expect(plan.pasteRows.map((r) => r.key)).toEqual([
      's1:slack-events',
      's1:slack-interactivity',
    ]);
  });

  test('pending slack → attempted too (pre-install app still holds a refresh chain) AND keeps its paste rows', () => {
    const plan = planRewire([slackConn('s1', 'pending')], null);
    expect(plan.slackAttemptIds).toEqual(['s1']);
    expect(plan.pasteRows.map((r) => r.key)).toEqual([
      's1:slack-events',
      's1:slack-interactivity',
    ]);
    expect(plan.pasteRows.every((r) => r.connectionId === 's1')).toBe(true);
  });

  test('inactive/disabled slack → NOT attempted, but paste rows remain', () => {
    const plan = planRewire([slackConn('s1', 'inactive'), slackConn('s2', 'disabled')], null);
    expect(plan.slackAttemptIds).toEqual([]);
    expect(plan.pasteRows.map((r) => r.key)).toEqual([
      's1:slack-events',
      's1:slack-interactivity',
      's2:slack-events',
      's2:slack-interactivity',
    ]);
  });

  test('every slack paste row is tagged with its connectionId', () => {
    const plan = planRewire([slackConn('s1', 'active')], null);
    expect(plan.pasteRows.every((r) => r.connectionId === 's1')).toBe(true);
  });

  test('email paste rows are also tagged with connectionId and are never attempted', () => {
    const plan = planRewire([emailConn('e1', 'active')], null);
    expect(plan.slackAttemptIds).toEqual([]);
    expect(plan.pasteRows).toHaveLength(1);
    expect(plan.pasteRows[0].connectionId).toBe('e1');
  });

  test('telegram is unchanged: active → reconnectIds, never in slackAttemptIds', () => {
    const plan = planRewire([tgConn('t1', 'active'), tgConn('t2', 'inactive')], null);
    expect(plan.reconnectIds).toEqual(['t1']);
    expect(plan.slackAttemptIds).toEqual([]);
    expect(plan.pasteRows).toEqual([]);
  });

  test('mixed fleet: active+pending slack attempted, inactive not; telegram/email routing intact', () => {
    const plan = planRewire(
      [
        tgConn('t1', 'active'),
        slackConn('s1', 'active'),
        slackConn('s2', 'inactive'),
        slackConn('s3', 'pending'),
        emailConn('e1', 'active'),
      ],
      null,
    );
    expect(plan.reconnectIds).toEqual(['t1']);
    expect(plan.slackAttemptIds).toEqual(['s1', 's3']);
    expect(plan.pasteRows.map((r) => r.key)).toEqual([
      's1:slack-events',
      's1:slack-interactivity',
      's2:slack-events',
      's2:slack-interactivity',
      's3:slack-events',
      's3:slack-interactivity',
      'e1:email',
    ]);
  });
});
