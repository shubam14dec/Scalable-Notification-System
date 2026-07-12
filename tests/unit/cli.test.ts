/**
 * @asyncify-hq/cli unit tests: the four pure modules that the CLI is built on —
 * argument parsing, cloudflared URL extraction, .env line rewriting, webhook
 * rewire planning, and the tunnel watchdog state machine. Imported straight out
 * of packages/cli/src the same way the agent SDK tests import packages/agent/src.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { parseArgs, SEED_API_KEY } from '../../packages/cli/src/args';
import { parseTunnelUrl, waitForTunnelReady } from '../../packages/cli/src/tunnel';
import { rewritePublicUrlLine } from '../../packages/cli/src/env-file';
import { planRewire, type Connection } from '../../packages/cli/src/rewire';
import { initWatchdogState, tick, type WdEvent, type WdState } from '../../packages/cli/src/watchdog';

// argv shape is the full process.argv: [node, script, command, ...rest].
const argv = (...parts: string[]): string[] => ['node', 'asyncify', ...parts];

describe('parseArgs: dev', () => {
  // parseDev consults process.env.ASYNCIFY_API_KEY for the key fallback, so we
  // restore it around every test that depends on it.
  const savedEnvKey = process.env.ASYNCIFY_API_KEY;
  afterEach(() => {
    if (savedEnvKey === undefined) delete process.env.ASYNCIFY_API_KEY;
    else process.env.ASYNCIFY_API_KEY = savedEnvKey;
  });

  test('dev with no flags → defaults, seed key when no env key', () => {
    delete process.env.ASYNCIFY_API_KEY;
    const args = parseArgs(argv('dev'));
    expect(args).toEqual({
      command: 'dev',
      port: 3000,
      apiUrl: 'http://localhost:3000',
      apiKey: SEED_API_KEY,
      apiKeyIsSeedDefault: true,
      envWrite: true,
    });
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

describe('waitForTunnelReady', () => {
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

  test('resolves after `consecutive` successes in a row', async () => {
    const { fn: fetchFn, calls } = fakeFetch([true, true]);
    const { fn: sleepFn } = fakeSleep();
    await expect(
      waitForTunnelReady('https://t.example', {
        fetchFn,
        sleepFn,
        consecutive: 2,
        maxWaitMs: 60_000,
        intervalMs: 2_000,
      }),
    ).resolves.toBeUndefined();
    // Polls health twice (two successes), no third poll after the streak is met.
    expect(calls).toEqual(['https://t.example/health', 'https://t.example/health']);
  });

  test('a failure between successes resets the streak', async () => {
    // ok, fail, ok, ok → only the last two are consecutive, so 4 polls total.
    const { fn: fetchFn, calls } = fakeFetch([true, false, true, true]);
    const { fn: sleepFn, waits } = fakeSleep();
    await waitForTunnelReady('https://t.example', {
      fetchFn,
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
