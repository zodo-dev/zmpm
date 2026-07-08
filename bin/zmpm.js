#!/usr/bin/env node
// zmpm entry point. Keeps the shebang file tiny; all logic lives in src/cli.js.
import { main } from '../src/cli.js';

main(process.argv.slice(2)).catch((err) => {
  console.error(`zmpm: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
