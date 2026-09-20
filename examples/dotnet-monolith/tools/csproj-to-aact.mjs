#!/usr/bin/env node
/**
 * csproj-to-aact — turn a .NET solution into an aact Model by reading
 * `<ProjectReference>` entries out of every `*.csproj`.
 *
 * This is the *declared* dependency graph: what each project says it needs.
 * No build required, so it runs on a clean checkout and sees references even
 * when no type from them is used. The compiled-assembly view is the other
 * source — see `assembly-to-aact` in this folder.
 *
 * Usage:
 *   node csproj-to-aact.mjs <solution-dir> <output.aact.json> [options]
 *
 * Options:
 *   --boundary <label>  Container the components live in (default "Monolith")
 *   --tags <file>       JSON map: project name → tags, e.g. { "Orders": ["bc:orders"] }
 *
 * Mapping project names to architecture elements is deliberately explicit:
 * only the team knows which projects form one module.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set([
  "bin",
  "obj",
  "node_modules",
  ".git",
  ".vs",
  ".idea",
]);

/** Stable element id: `Inventory.Contracts` → `inventory_contracts`. */
export const idOf = (projectName) =>
  projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

const collectProjects = async (dir, found = []) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name))
        await collectProjects(join(dir, entry.name), found);
    } else if (entry.name.endsWith(".csproj")) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
};

/**
 * `<ProjectReference Include="..\Foo\Foo.csproj" />` → absolute paths.
 * Conditional references are returned too: a `Condition` is an MSBuild
 * expression we do not evaluate, and a reference behind a flag is still a
 * declared dependency worth reviewing.
 */
const referencesOf = (csprojPath, xml) =>
  [...xml.matchAll(/<ProjectReference\b[^>]*\bInclude\s*=\s*"([^"]+)"/g)].map(
    (match) => resolve(dirname(csprojPath), match[1].replaceAll("\\", "/")),
  );

/**
 * Build the Model. Components are projects, relations are ProjectReference
 * edges, everything sits inside one container boundary — a modular monolith
 * is a single deployable, so C4-wise these are components, not containers.
 */
export const buildModel = async (solutionDir, options = {}) => {
  const { boundary = "Monolith", tags = {}, technology = "dotnet" } = options;
  const projectPaths = (await collectProjects(resolve(solutionDir))).sort();
  const nameByPath = new Map(
    projectPaths.map((path) => [path, basename(path, ".csproj")]),
  );

  const elements = {};
  for (const path of projectPaths) {
    const name = nameByPath.get(path);
    const xml = await readFile(path, "utf8");
    const relations = referencesOf(path, xml)
      .filter((target) => nameByPath.has(target))
      .map((target) => ({
        to: idOf(nameByPath.get(target)),
        description: "",
        tags: [],
        technology: "ProjectReference",
      }))
      .sort((a, b) => a.to.localeCompare(b.to));

    elements[idOf(name)] = {
      name: idOf(name),
      label: name,
      kind: "Component",
      external: false,
      description: "",
      technology,
      tags: tags[name] ?? [],
      relations,
    };
  }

  const boundaryId = idOf(boundary);
  return {
    elements,
    boundaries: {
      [boundaryId]: {
        name: boundaryId,
        label: boundary,
        kind: "Container",
        tags: [],
        elementNames: Object.keys(elements),
        boundaryNames: [],
      },
    },
    rootBoundaryNames: [boundaryId],
  };
};

const parseArgs = (argv) => {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--boundary") options.boundary = argv[(i += 1)];
    else if (argv[i] === "--tags") options.tagsFile = argv[(i += 1)];
    else positional.push(argv[i]);
  }
  return { positional, options };
};

const main = async (argv) => {
  const { positional, options } = parseArgs(argv);
  if (positional.length !== 2) {
    console.error(
      "Usage: node csproj-to-aact.mjs <solution-dir> <output.aact.json> [--boundary <label>] [--tags <file>]",
    );
    return 2;
  }

  const tags = options.tagsFile
    ? JSON.parse(await readFile(options.tagsFile, "utf8"))
    : {};
  const model = await buildModel(positional[0], { ...options, tags });
  await writeFile(
    positional[1],
    `${JSON.stringify({ schemaVersion: 1, model }, undefined, 2)}\n`,
  );

  const edges = Object.values(model.elements).reduce(
    (total, element) => total + element.relations.length,
    0,
  );
  console.log(
    `${Object.keys(model.elements).length} projects, ${edges} references → ${positional[1]}`,
  );
  return 0;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
