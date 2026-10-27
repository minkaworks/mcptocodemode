// The CLI and full benchmark use the same measurement. Build first.
import { pathToFileURL } from "node:url";
import { measureMail } from "../dist/demo.js";
export { measureMail };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(await measureMail(), null, 2)}\n`);
}
