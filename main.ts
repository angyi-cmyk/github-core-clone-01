// github-core-clone-01 entrypoint.
//
// One process: start the forge from ./app.ts on a kernel-chosen port,
// tell the trial suite where it is, then stay up until the suite says
// it is done. Node stdlib only (plus the app import); no git binary.

import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from './app.ts';

// How long we keep trying to reach the suite before giving up.
const ANNOUNCE_BUDGET_MS = 120_000;
const POLL_GAP_MS = 750;
const ANNOUNCE_RETRY_MS = 500;

// The suite's base URL comes from the environment, e.g. http://store:8080.
function suiteBase(): string {
  const base = (process.env.MAKEFUN_ENV_URL ?? '').trim();
  if (!base) {
    throw new Error('MAKEFUN_ENV_URL is not set; nothing to register with');
  }
  return base.replace(/\/+$/, '');
}

// POST {"port": n} to <base>/register. The suite may not be listening
// yet when we start, so retry until it answers or the budget runs out.
async function announcePort(base: string, port: number): Promise<void> {
  const deadline = Date.now() + ANNOUNCE_BUDGET_MS;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const reply = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (reply.ok) {
        console.log(`forge: registered port ${port} (attempt ${attempt})`);
        return;
      }
      console.error(`forge: register answered ${reply.status}, retrying`);
    } catch (err) {
      console.error(`forge: register attempt ${attempt} failed: ${err}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`could not register port ${port} after ${attempt} attempts`);
    }
    await sleep(ANNOUNCE_RETRY_MS);
  }
}

// GET <base>/done until the suite reports {"done": true}. A dropped
// connection or a non-JSON answer just means "not yet": wait and ask again.
async function waitForSuiteDone(base: string): Promise<void> {
  for (;;) {
    try {
      const reply = await fetch(`${base}/done`);
      if (reply.ok) {
        const body = (await reply.json()) as { done?: unknown };
        if (body.done === true) {
          console.log('forge: suite finished, shutting down');
          return;
        }
      } else {
        console.error(`forge: /done answered ${reply.status}, still waiting`);
      }
    } catch (err) {
      console.error(`forge: /done poll failed: ${err}`);
    }
    await sleep(POLL_GAP_MS);
  }
}

async function boot(): Promise<void> {
  const base = suiteBase();
  const forge = createApp();

  // Port 0: the kernel picks a free port. Never 8080 — that is the suite's.
  const port = await new Promise<number>((resolve, reject) => {
    forge.once('error', reject);
    forge.listen(0, '0.0.0.0', () => {
      const addr = forge.address();
      if (addr && typeof addr === 'object') {
        resolve(addr.port);
      } else {
        reject(new Error('could not read the bound port'));
      }
    });
  });
  console.log(`forge: listening on ${port}`);

  await announcePort(base, port);
  await waitForSuiteDone(base);

  // The suite may still hold keep-alive connections; close() alone waits
  // for them to end, so drop them first or shutdown could hang here.
  forge.closeAllConnections();
  await new Promise<void>((resolve) => forge.close(() => resolve()));
}

boot().catch((err: unknown) => {
  console.error(`forge: fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
