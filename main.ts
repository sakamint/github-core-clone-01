// The forge's side of the harness handshake, in the kit's own wire terms: the entry binds a port
// of its own, tells the environment where it listens, and then keeps asking whether the trial is
// over until the environment says so. Nothing here serves requests — app.ts owns the forge — this
// file only keeps the process alive for exactly as long as the trial runs.
//
// Order of events:
//   - MAKEFUN_ENV_URL must name the environment's origin; without it there is nothing to join.
//   - The forge binds port 0, so the kernel hands it a free port, and it never touches 8080.
//   - POST /register carries that port. 200 means accepted, 409 means some other entry registered
//     first (this process still waits it out like any other). 400/405 mean the request itself is
//     wrong, so the process gives up at once; anything else is retried, because the environment
//     may still be coming up.
//   - GET /done is polled until it answers {"done": true}. A poll that fails or times out only
//     means "not yet", never a reason to quit.
//   - Once done, the server is closed and the process leaves with status 0; any earlier failure
//     leaves with status 1.

import { createApp } from "./app.ts";

const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? "").trim().replace(/\/+$/, "");
if (ENV_ORIGIN === "") {
  process.stderr.write("[forge] MAKEFUN_ENV_URL is not set, so there is no environment to join\n");
  process.exit(1);
}

/** The longest one register/done call may run before it is dropped and tried again. */
const CALL_LIMIT_MS = 20_000;
/** The first pause between retries, and the longest pause. */
const FIRST_WAIT_MS = 200;
const LONGEST_WAIT_MS = 1_500;

const pause = (ms: number): Promise<void> => new Promise((wake) => setTimeout(wake, ms));

/**
 * A backoff that doubles from `first`, capped at `ceiling`, and remembers how many waits it has
 * already handed out, so callers just ask for the next pause.
 */
function makeBackoff(first: number, ceiling: number): () => number {
  let handed = 0;
  return () => {
    const wait = Math.min(ceiling, first * 2 ** Math.min(handed, 7));
    handed += 1;
    return wait;
  };
}

/** The environment's address for one of its paths. */
const envUrl = (path: string): string => `${ENV_ORIGIN}${path}`;

/**
 * Tell the environment the port the forge bound. Accepts 200 and 409; 400/405 end the program
 * because the request itself is malformed; every other outcome waits and tries again.
 */
async function announcePort(port: number, nextWait: () => number): Promise<void> {
  for (;;) {
    const reply = await fetch(envUrl("/register"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: port }),
      signal: AbortSignal.timeout(CALL_LIMIT_MS),
    }).catch(() => null);
    if (reply === null) {
      await pause(nextWait());
      continue;
    }
    if (reply.status === 200 || reply.status === 409) return;
    if (reply.status === 400 || reply.status === 405) {
      throw new Error(`registration refused with HTTP ${reply.status}`);
    }
    await pause(nextWait());
  }
}

/** Ask GET /done until it answers {"done": true}; a failed poll just means "not yet". */
async function awaitFinished(nextWait: () => number): Promise<void> {
  for (;;) {
    try {
      const reply = await fetch(envUrl("/done"), { signal: AbortSignal.timeout(CALL_LIMIT_MS) });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The environment did not answer, or its answer was unreadable: keep polling.
    }
    await pause(nextWait());
  }
}

/** Bind, register, wait for the trial to end, then shut down. */
async function run(): Promise<void> {
  const forge = createApp();
  await new Promise<void>((started, failed) => {
    forge.once("error", failed);
    forge.listen(0, () => started());
  });
  const bound = forge.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("the forge did not bind a TCP port");
  }
  process.stdout.write(`[forge] listening on ${bound.port}\n`);

  const nextWait = makeBackoff(FIRST_WAIT_MS, LONGEST_WAIT_MS);
  await announcePort(bound.port, nextWait);
  process.stdout.write("[forge] registered; waiting for the environment to finish\n");
  await awaitFinished(nextWait);

  forge.close();
  process.stdout.write("[forge] trial over; shutting down\n");
}

run().then(
  () => process.exit(0),
  (failure: unknown) => {
    process.stderr.write(`[forge] ${failure instanceof Error ? failure.message : String(failure)}\n`);
    process.exit(1);
  },
);
