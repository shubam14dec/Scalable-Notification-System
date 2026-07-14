/**
 * `asyncify dev` — stand up a managed cloudflared tunnel, publish its URL to
 * the local Asyncify stack, rewire every channel webhook, and keep the tunnel
 * healthy (auto-rotating when cloudflared drops).
 */

import { spawn, type ChildProcess } from 'node:child_process';

import type { DevArgs } from './args';
import { apiFetch } from './api';
import { spawnTunnel, waitForTunnelReady } from './tunnel';
import { runRewire } from './rewire';
import { startWatchdog, type WatchdogController } from './watchdog';

const CLOUDFLARED_INSTALL = [
  'cloudflared is required but was not found on PATH. Install it:',
  '  Windows:  winget install --id Cloudflare.cloudflared',
  '  macOS:    brew install cloudflared',
  '  Linux:    sudo apt install cloudflared   (or see the docs)',
  '  Docs:     https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
];

/** Probe `cloudflared --version`; resolve its output or reject (ENOENT etc). */
function checkCloudflared(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('cloudflared', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`cloudflared --version exited ${code}`));
    });
  });
}

export async function runDev(args: DevArgs): Promise<void> {
  console.log('asyncify dev — starting up\n');
  if (args.apiKeyIsSeedDefault) {
    console.log(
      `  ℹ using the dev seed API key (${args.apiKey}). Set ASYNCIFY_API_KEY or --api-key to target another tenant.\n`,
    );
  }

  // ---- preflight ----
  try {
    const version = await checkCloudflared();
    console.log(`  ✔ cloudflared present (${version.split('\n')[0]})`);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    console.error(`  ✖ ${e.code === 'ENOENT' ? '' : e.message}`.trimEnd());
    console.error(CLOUDFLARED_INSTALL.join('\n'));
    process.exit(1);
  }

  try {
    const health = await apiFetch(args.apiUrl, args.apiKey, 'GET', '/health');
    if (health.status !== 200) {
      console.error(`  ✖ Asyncify API health check failed (${health.status}) at ${args.apiUrl}`);
      process.exit(1);
    }
    console.log(`  ✔ Asyncify API reachable at ${args.apiUrl}`);
  } catch (err) {
    console.error(`  ✖ could not reach Asyncify API at ${args.apiUrl}: ${(err as Error).message}`);
    console.error('    Is the stack running? (npm run api)');
    process.exit(1);
  }

  try {
    const conns = await apiFetch(args.apiUrl, args.apiKey, 'GET', '/v1/connections');
    if (conns.status === 401) {
      console.error('  ✖ API key rejected (401). Check ASYNCIFY_API_KEY / --api-key.');
      process.exit(1);
    }
    if (conns.status !== 200) {
      console.error(`  ✖ GET /v1/connections returned ${conns.status}`);
      process.exit(1);
    }
    console.log('  ✔ API key accepted');
  } catch (err) {
    console.error(`  ✖ auth check failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // ---- tunnel + first rewire ----
  console.log('\n  spinning up the tunnel…');
  let tunnel = await spawnTunnel(args.port);
  let child: ChildProcess = tunnel.child;
  let currentUrl = tunnel.url;
  let prevUrls: Map<string, string> | null = null;
  let rotationCount = 0;
  console.log(`  ✔ tunnel live: ${currentUrl}  →  http://localhost:${args.port}\n`);

  // Do NOT rewire until the tunnel is publicly reachable — registering the
  // hostname before its DNS record exists makes Telegram negative-cache
  // NXDOMAIN for minutes. See waitForTunnelReady.
  try {
    console.log('  waiting for the tunnel to be publicly reachable…');
    await waitForTunnelReady(currentUrl);
    console.log('  ✔ tunnel is publicly reachable\n');
  } catch (err) {
    console.error(`  ✖ ${(err as Error).message}`);
    process.exit(1);
  }

  prevUrls = await runRewire({
    baseUrl: args.apiUrl,
    apiKey: args.apiKey,
    tunnelUrl: currentUrl,
    prevUrls,
    envWrite: args.envWrite,
  });

  // ---- watchdog ----
  let watchdog: WatchdogController;

  async function rotate(): Promise<void> {
    rotationCount += 1;
    // Detach the exit listener so this intentional kill doesn't re-trigger.
    child.removeAllListeners('exit');
    if (!child.killed) child.kill();
    // Set once spawnTunnel succeeds, so the catch below can tell a post-spawn
    // failure (fresh child alive but unusable) from a spawn failure (no new
    // child; `child` still points at the old, already-killed process).
    let spawned: ChildProcess | null = null;
    try {
      tunnel = await spawnTunnel(args.port);
      child = tunnel.child;
      spawned = child;
      currentUrl = tunnel.url;
      wireChildExit();
      console.log(`\n  ↻ tunnel rotated: ${currentUrl}\n`);
      // Same DNS-race guard as initial start. A throw here is caught below and
      // handed to the watchdog's rotation-failure path — never crash the process.
      console.log('  waiting for the tunnel to be publicly reachable…');
      await waitForTunnelReady(currentUrl);
      console.log('  ✔ tunnel is publicly reachable\n');
      prevUrls = await runRewire({
        baseUrl: args.apiUrl,
        apiKey: args.apiKey,
        tunnelUrl: currentUrl,
        prevUrls,
        envWrite: args.envWrite,
      });
    } catch (err) {
      console.error(`  ✖ tunnel rotation failed: ${(err as Error).message}`);
      if (spawned !== null) {
        // The fresh cloudflared spawned but never became usable (readiness
        // timeout, or the rewire failed). Left alone it is a zombie: if it
        // later turns healthy the watchdog sees health_ok forever while the
        // platform was never rewired to it — channels dark indefinitely.
        // Discard it so the wired exit listener feeds child_exit into the
        // watchdog, which immediately rotates again (still subject to the
        // 5-rotations-in-120s breaker).
        console.error('  ✖ tunnel never became usable — discarding it and rotating again');
        if (spawned.exitCode === null && spawned.signalCode === null) {
          // Still running: kill it. kill() on a process that races us and
          // dies first returns false without throwing, and the exit event
          // (listener still attached) drives the watchdog either way.
          spawned.kill();
        } else {
          // Already dead: its exit event fired while this rotation was in
          // flight and was swallowed by the watchdog's busy guard. Re-notify
          // once the current rotation has fully unwound (setImmediate runs
          // after the busy flag is cleared in the microtask queue).
          setImmediate(() => watchdog.notifyChildExit());
        }
      }
    }
  }

  function wireChildExit(): void {
    const c = child;
    c.on('exit', () => {
      if (c === child) watchdog.notifyChildExit();
    });
  }

  watchdog = startWatchdog({
    getTunnelUrl: () => currentUrl,
    onRotate: rotate,
    onPause: () => console.log('  ⏸ pausing rotations for 60s (tunnel flapping)'),
    log: (m) => console.log(`  ${m}`),
  });
  wireChildExit();

  console.log('  watching the tunnel — press Ctrl+C to stop.\n');

  // ---- shutdown ----
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    watchdog.stop();
    child.removeAllListeners('exit');
    if (!child.killed) child.kill();
    console.log(
      `\nasyncify dev stopped.\n  last URL: ${currentUrl}\n  rotations this session: ${rotationCount}`,
    );
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
