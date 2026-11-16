// dev.ts — standalone runner for local development and testing.
//
// Listens on a fixed port (FORGE_DEV_PORT, default 8123) and does not
// register with any trial environment. Run with:
//
//   MAKEFUN_SHOP_TOKEN=dev-token node --experimental-strip-types dev.ts
//
// With MAKEFUN_SHOP_TOKEN unset, any bearer token is accepted.

import { createApp } from './app.ts';

const port = Number(process.env.FORGE_DEV_PORT ?? '8123');
const app = createApp({});
app.listen(port, () => {
  console.log(`forge listening on http://127.0.0.1:${port}`);
});
