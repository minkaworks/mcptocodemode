// Compatibility entry point for contributors. The installed command is cm demo.
import { runDemo } from "../dist/demo.js";
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--json") || args.length > 1) {
  process.stderr.write("Usage: node scripts/demo.mjs [--json]\n");
  process.exitCode = 1;
} else {
  process.stdout.write(await runDemo(args.includes("--json")));
}
