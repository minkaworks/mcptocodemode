const RESERVED = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "let",
  "static",
  "yield",
  "enum",
  "await",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "arguments",
  "eval",
  "undefined",
  "NaN",
  "Infinity",
  "codemode",
  "state",
  "console",
  "globalThis",
  "constructor",
  "prototype",
]);

/** Turn an arbitrary MCP name into a JavaScript identifier. */
export function toIdent(raw: string): string {
  const ident = sanitize(raw);
  return RESERVED.has(ident) ? `${ident}_` : ident;
}

/** Pick an identifier that does not collide with `used`. */
export function uniqueIdent(raw: string, used: Set<string>): string {
  return unique(toIdent(raw), used);
}

// A method is a property (`notes.delete(...)`), so keywords are fine there.
// Only names that would shadow the namespace object's own machinery change.
const RESERVED_METHODS = new Set(["constructor", "prototype"]);

/** Pick a method name that does not collide with `used`. */
export function uniqueMethodIdent(raw: string, used: Set<string>): string {
  const ident = sanitize(raw);
  return unique(RESERVED_METHODS.has(ident) ? `${ident}_` : ident, used);
}

function sanitize(raw: string): string {
  let ident = raw
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!ident) ident = "tool";
  if (/^[0-9]/.test(ident)) ident = `_${ident}`;
  return ident;
}

function unique(base: string, used: Set<string>): string {
  let ident = base;
  let n = 2;
  while (used.has(ident)) {
    ident = `${base}_${n}`;
    n += 1;
  }
  used.add(ident);
  return ident;
}
