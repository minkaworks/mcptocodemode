import type { JsonSchema } from "./types.js";

type RenderOpts = {
  docChars: number;
};

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

function propKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function literal(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return JSON.stringify(value);
  }
  return "unknown";
}

function docLine(description: string | undefined, indent: string, opts: RenderOpts): string {
  if (!description) return "";
  const text = clip(description, opts.docChars).replace(/\*\//g, "* /");
  return `${indent}/** ${text} */\n`;
}

export function schemaToType(schema: JsonSchema | undefined, depth = 0, opts: RenderOpts = { docChars: 200 }): string {
  if (!schema) return "unknown";
  if (schema.const !== undefined) return literal(schema.const);
  if (schema.enum && schema.enum.length > 0) return schema.enum.map(literal).join(" | ");

  const union = schema.oneOf ?? schema.anyOf;
  if (union && union.length > 0) {
    return union.map((part) => schemaToType(part, depth, opts)).join(" | ");
  }

  if (Array.isArray(schema.type)) {
    return schema.type.map((type) => schemaToType({ ...schema, type }, depth, opts)).join(" | ");
  }

  if (schema.type === "object" || schema.properties) return objectType(schema, depth, opts);
  if (schema.type === "array") return arrayType(schema, depth, opts);
  if (schema.type === "string") return "string";
  if (schema.type === "number" || schema.type === "integer") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "null") return "null";
  return "unknown";
}

function objectType(schema: JsonSchema, depth: number, opts: RenderOpts): string {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const pad = "  ".repeat(depth + 1);
  const end = "  ".repeat(depth);
  const lines: string[] = [];

  for (const [key, value] of Object.entries(properties)) {
    const optional = required.has(key) ? "" : "?";
    lines.push(
      `${docLine(value.description, pad, opts)}${pad}${propKey(key)}${optional}: ${schemaToType(value, depth + 1, opts)};`,
    );
  }

  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    lines.push(`${pad}[key: string]: ${schemaToType(schema.additionalProperties, depth + 1, opts)};`);
  } else if (schema.additionalProperties === true) {
    lines.push(`${pad}[key: string]: unknown;`);
  }

  if (lines.length === 0) {
    return schema.additionalProperties === false ? "{}" : "Record<string, unknown>";
  }
  return `{\n${lines.join("\n")}\n${end}}`;
}

function arrayType(schema: JsonSchema, depth: number, opts: RenderOpts): string {
  if (Array.isArray(schema.items)) {
    const parts = schema.items.map((item) => schemaToType(item, depth, opts));
    return `[${parts.join(", ")}]`;
  }
  const item = schemaToType(schema.items, depth, opts);
  // `A | B[]` is A or an array of B. An array of the union needs parentheses.
  return item.includes(" | ") ? `(${item})[]` : `${item}[]`;
}

/** Argument type for a tool. Empty required lists make the argument optional at the call site. */
export function inputType(schema: JsonSchema, opts: RenderOpts): { type: string; optional: boolean } {
  const type = schemaToType(schema, 1, opts);
  const required = schema.required ?? [];
  return { type, optional: required.length === 0 };
}
