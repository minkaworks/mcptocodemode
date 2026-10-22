import { createRequire } from "node:module";

/** Package version. `package.json` sits one level above both `src/` and `dist/`. */
export const VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
