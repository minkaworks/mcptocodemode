// Release helpers shared by CI, the release workflow, and a maintainer.
//
//   node scripts/release.mjs notes 0.2.1   print that CHANGELOG section
//   node scripts/release.mjs check         check the package is publishable
//   node scripts/release.mjs check v0.2.1  also check the tag matches it
//
// `check` expects `dist/` to be built.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");

const [command, arg] = process.argv.slice(2);
if (command === "notes") {
  process.stdout.write(`${notes(arg ?? pkg.version)}\n`);
} else if (command === "check") {
  const problems = check(arg);
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`release: ${problem}\n`);
    process.exit(1);
  }
  process.stdout.write(`release: ${pkg.name}@${pkg.version} is publishable${arg ? ` as ${arg}` : ""}\n`);
} else {
  process.stderr.write("usage: node scripts/release.mjs notes [version] | check [vX.Y.Z]\n");
  process.exit(2);
}

/** The body of `## [version] - date`, without the heading. */
function notes(version) {
  const heading = new RegExp(`^## \\[${escape(version)}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m");
  const match = heading.exec(changelog);
  if (!match) throw new Error(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section`);
  const rest = changelog.slice(match.index + match[0].length);
  const end = rest.search(/^## \[|^\[[^\]]+\]: /m);
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

function check(tag) {
  const problems = [];
  const version = pkg.version;
  if (tag && tag !== `v${version}`) problems.push(`tag ${tag} does not match package.json version ${version}`);

  try {
    if (!notes(version)) problems.push(`CHANGELOG.md section ${version} is empty`);
  } catch (error) {
    problems.push(error.message);
  }
  if (!changelog.includes(`\n[${version}]: `)) problems.push(`CHANGELOG.md has no [${version}] link`);

  // npm 11 rewrites and then drops a bin path written as ./file, so keep it plain.
  for (const [name, file] of Object.entries(pkg.bin ?? {})) {
    if (file.startsWith("./")) problems.push(`bin ${name} is "${file}"; write it as "${file.slice(2)}"`);
    const full = path.join(root, file);
    if (!existsSync(full)) problems.push(`bin ${name} points at ${file}, which is not built`);
    else if (!readFileSync(full, "utf8").startsWith("#!/usr/bin/env node")) problems.push(`${file} has no node shebang`);
  }

  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" }),
  )[0];
  const files = new Set(packed.files.map((file) => file.path));
  for (const required of ["LICENSE", "README.md", "package.json", ...Object.values(pkg.bin ?? {}), pkg.exports?.["."]]) {
    const file = required?.replace(/^\.\//, "");
    if (file && !files.has(file)) problems.push(`the package would not contain ${file}`);
  }
  return problems;
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
