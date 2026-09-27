#!/usr/bin/env node
import { isCliError, main } from "../src/cli.js";

main(process.argv.slice(2)).catch((e) => {
  console.error(isCliError(e) ? e.message : `Error: ${e?.message ?? e}`);
  process.exit(1);
});
