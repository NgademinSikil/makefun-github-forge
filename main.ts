// main.ts — the forge's entry point for the make.fun trial.
//
// Lifecycle (per the bounty kit): bind an ephemeral port, POST {"port": N}
// to $MAKEFUN_ENV_URL/register, poll GET $MAKEFUN_ENV_URL/done until
// {"done": true}, then exit 0. Exits 1 when MAKEFUN_ENV_URL is unset.
//
// Run with: node --experimental-strip-types main.ts
// (Node 22 or later; erasable TypeScript only, standard library only.)

import { createApp } from './app.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (!envUrl) {
    console.error('MAKEFUN_ENV_URL is not set');
    process.exit(1);
  }

  const app = createApp({});
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const listening = app.listen(0, () => resolve(listening));
    listening.on('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    console.error('could not determine the listening port');
    process.exit(1);
  }
  const port = address.port;

  const registerUrl = `${envUrl}/register`;
  const registerResponse = await fetch(registerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (!registerResponse.ok) {
    console.error(`register failed: ${registerResponse.status}`);
    process.exit(1);
  }

  const doneUrl = `${envUrl}/done`;
  let delayMs = 250;
  for (;;) {
    const response = await fetch(doneUrl);
    if (response.ok) {
      const body: unknown = await response.json();
      if (body !== null && typeof body === 'object' && (body as { done?: unknown }).done === true) {
        break;
      }
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 5000);
  }

  server.close(() => process.exit(0));
  // Do not hang on a stray keep-alive socket.
  setTimeout(() => process.exit(0), 2000).unref();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
