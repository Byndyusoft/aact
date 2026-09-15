import fs from "node:fs/promises";

import path from "pathe";

import type {
  Boundary,
  Element,
  ElementKind,
  ModelIssue,
  Relation,
} from "../../model";
import { buildModel, meaningfulTags } from "../../model";
import { toIncludeError } from "../_shared/includeError";
import { inferKindFromTechnology } from "../_shared/kindHeuristics";
import { parseCsvTags } from "../_shared/tags";
import type { LoadResult } from "../types";
import { parseSource } from "./parser";
import type {
  StructurizrComponent,
  StructurizrContainer,
  StructurizrPerson,
  StructurizrProperties,
  StructurizrRelationship,
  StructurizrSoftwareSystem,
  StructurizrWorkspace,
} from "./types";
import {
  STRUCTURIZR_INTERACTION_ASYNC,
  STRUCTURIZR_LOCATION_EXTERNAL,
  STRUCTURIZR_TAG_ASYNC,
} from "./types";

const STRUCTURIZR_DSL_IDENTIFIER = "structurizr.dsl.identifier";

/** Resolve human-readable name через `structurizr.dsl.identifier` property,
 * fallback на raw id. Это позволяет правилам ссылаться на читаемые имена. */
const dslId = (id: string, properties?: StructurizrProperties): string =>
  properties?.[STRUCTURIZR_DSL_IDENTIFIER] ?? id;

/**
 * Composite properties bag: user-defined + group (как prefix `group`) +
 * perspectives (как `perspective.<name>` + опциональный `perspective.<name>.value`).
 *
 * Solution Architect добавляет perspectives (security/scalability/ops view)
 * к одной модели — сохраняем для round-trip без потерь. Без этого rules не
 * увидят что у container'а есть security-related metadata.
 */
const toProperties = (
  base: StructurizrProperties | undefined,
  group?: string,
  perspectives?: Record<string, { description: string; value?: string }>,
): Element["properties"] => {
  const out: Record<string, string> = {};
  if (base) {
    for (const [k, v] of Object.entries(base)) {
      if (k === STRUCTURIZR_DSL_IDENTIFIER) continue;
      if (typeof v === "string") out[k] = v;
    }
  }
  if (group !== undefined && group.length > 0) out.group = group;
  if (perspectives) {
    for (const [name, p] of Object.entries(perspectives)) {
      out[`perspective.${name}`] = p.description;
      if (p.value !== undefined) out[`perspective.${name}.value`] = p.value;
    }
  }
  if (Object.keys(out).length === 0) return undefined;
  return Object.freeze(out);
};

const isExternal = (system: StructurizrSoftwareSystem): boolean =>
  system.location === STRUCTURIZR_LOCATION_EXTERNAL ||
  (system.tags?.includes(STRUCTURIZR_LOCATION_EXTERNAL) ?? false);

/**
 * Tags from an exported `workspace.json` carry Structurizr's implicit
 * styling tags ("Element", "Container", …); strip them so a model loaded
 * from JSON matches the same model loaded from `.dsl` (which no longer
 * stamps them). External detection above reads the raw tag string, so
 * dropping them from `Model.tags` is safe.
 */
const userTags = (raw: string | undefined): string[] =>
  meaningfulTags(parseCsvTags(raw));

const buildPersonContainer = (p: StructurizrPerson): Element => ({
  name: dslId(p.id, p.properties),
  label: p.name,
  kind: "Person",
  external: false,
  description: p.description ?? "",
  tags: userTags(p.tags),
  relations: [],
  link: p.url,
  properties: toProperties(p.properties, p.group, p.perspectives),
});

const buildExternalSystemContainer = (
  s: StructurizrSoftwareSystem,
): Element => ({
  name: dslId(s.id, s.properties),
  label: s.name,
  kind: "System",
  external: true,
  description: s.description ?? "",
  tags: userTags(s.tags),
  relations: [],
  link: s.url,
  properties: toProperties(s.properties, s.group, s.perspectives),
});

const buildInternalSystemContainer = (
  s: StructurizrSoftwareSystem,
): Element => ({
  name: dslId(s.id, s.properties),
  label: s.name,
  kind: "System",
  external: false,
  description: s.description ?? "",
  tags: userTags(s.tags),
  relations: [],
  link: s.url,
  properties: toProperties(s.properties, s.group, s.perspectives),
});

const buildContainer = (c: StructurizrContainer): Element => ({
  name: dslId(c.id, c.properties),
  label: c.name,
  kind: inferKindFromTechnology(c.technology, c.name),
  external: false,
  description: c.description ?? "",
  technology: c.technology,
  tags: userTags(c.tags),
  relations: [],
  link: c.url,
  properties: toProperties(c.properties, c.group, c.perspectives),
});

const componentKindFromTechnology = (
  technology: string | undefined,
  name: string,
): ElementKind => {
  const inferred = inferKindFromTechnology(technology, name);
  if (inferred === "ContainerDb") return "ComponentDb";
  if (inferred === "ContainerQueue") return "ComponentQueue";
  return "Component";
};

const buildComponent = (c: StructurizrComponent): Element => ({
  name: dslId(c.id, c.properties),
  label: c.name,
  kind: componentKindFromTechnology(c.technology, c.name),
  external: false,
  description: c.description ?? "",
  technology: c.technology,
  tags: userTags(c.tags),
  relations: [],
  link: c.url,
  properties: toProperties(c.properties, c.group, c.perspectives),
});

const hasComponents = (c: StructurizrContainer): boolean =>
  (c.components?.length ?? 0) > 0;

const buildContainerBoundary = (c: StructurizrContainer): Boundary => ({
  name: dslId(c.id, c.properties),
  label: c.name,
  kind: "Container",
  description: c.description,
  tags: userTags(c.tags),
  elementNames: (c.components ?? []).map((component) =>
    dslId(component.id, component.properties),
  ),
  boundaryNames: [],
  link: c.url,
  properties: toProperties(c.properties, c.group, c.perspectives),
});

const buildSystemBoundary = (
  s: StructurizrSoftwareSystem,
  childContainers: readonly StructurizrContainer[],
): Boundary => ({
  name: dslId(s.id, s.properties),
  label: s.name,
  kind: "System",
  description: s.description,
  tags: userTags(s.tags),
  elementNames: childContainers
    .filter((c) => !hasComponents(c))
    .map((c) => dslId(c.id, c.properties)),
  boundaryNames: childContainers
    .filter(hasComponents)
    .map((c) => dslId(c.id, c.properties)),
  link: s.url,
  properties: toProperties(s.properties, s.group, s.perspectives),
});

const buildRelation = (
  rel: StructurizrRelationship,
  targetName: string,
): Relation => {
  const baseTags = userTags(rel.tags);
  const tags =
    rel.interactionStyle === STRUCTURIZR_INTERACTION_ASYNC
      ? [...baseTags, STRUCTURIZR_TAG_ASYNC]
      : baseTags;
  return {
    to: targetName,
    description: rel.description,
    technology: rel.technology,
    tags,
    link: rel.url,
    properties: toProperties(rel.properties, undefined, rel.perspectives),
  };
};

const HTTP_URL_RE = /^https?:\/\//i;

const stripQuoted = (value: string): string => {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const parseLocalIncludeTarget = (line: string): string | undefined => {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("!include")) return undefined;
  const raw = trimmed.slice("!include".length);
  if (raw.length === 0 || !/\s/u.test(raw[0])) return undefined;

  const value = raw.trim();
  const target =
    value.startsWith('"') || value.startsWith("'")
      ? stripQuoted(value)
      : (value.split(/\s+/u)[0] ?? "");
  if (target.length === 0 || HTTP_URL_RE.test(target)) return undefined;
  return target;
};

const expandDslIncludePath = async (
  includePath: string,
  stack: Set<string>,
): Promise<string> => {
  const stat = await fs.stat(includePath);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(includePath, { withFileTypes: true });
    const parts: string[] = [];
    for (const entry of entries
      .filter((e) => e.isFile() && !e.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      parts.push(
        await expandDslIncludes(path.join(includePath, entry.name), stack),
      );
    }
    return parts.join("\n");
  }
  return expandDslIncludes(includePath, stack);
};

const expandDslIncludes = async (
  filepath: string,
  stack = new Set<string>(),
): Promise<string> => {
  const absPath = path.resolve(filepath);
  if (stack.has(absPath)) {
    throw new Error(`Structurizr DSL include cycle detected: ${absPath}`);
  }

  stack.add(absPath);
  try {
    const text = await fs.readFile(absPath, "utf8");
    const out: string[] = [];
    let lineNumber = 0;
    for (const line of text.split(/(?<=\n)/u)) {
      lineNumber += 1;
      let newline = "";
      if (line.endsWith("\r\n")) {
        newline = "\r\n";
      } else if (line.endsWith("\n")) {
        newline = "\n";
      }
      const content = newline ? line.slice(0, -newline.length) : line;
      const target = parseLocalIncludeTarget(content);
      if (target === undefined) {
        out.push(line);
        continue;
      }

      const includePath = path.resolve(path.dirname(absPath), target);
      let expanded: string;
      try {
        expanded = await expandDslIncludePath(includePath, stack);
      } catch (error) {
        // Name the missing include, not the workspace file that
        // references it — the latter is the one file that does exist.
        throw toIncludeError(
          error,
          {
            missingPath: includePath,
            target,
            includedFrom: absPath,
            line: lineNumber,
            column: content.length - content.trimStart().length + 1,
          },
          "Structurizr DSL",
        );
      }
      out.push(expanded);
      if (newline && !expanded.endsWith("\n")) out.push(newline);
    }
    return out.join("");
  } finally {
    stack.delete(absPath);
  }
};

interface ElementWithRelations {
  readonly sourceId: string;
  readonly relationships?: readonly StructurizrRelationship[];
}

interface StructurizrLoadState {
  readonly containers: Element[];
  readonly boundaries: Boundary[];
  readonly rootBoundaryNames: string[];
  readonly loaderIssues: ModelIssue[];
  readonly idToName: Map<string, string>;
  /** Subset of idToName — только ids которые мапятся в Element. */
  readonly idToContainerName: Map<string, string>;
}

const createStructurizrLoadState = (): StructurizrLoadState => ({
  containers: [],
  boundaries: [],
  rootBoundaryNames: [],
  loaderIssues: [],
  idToName: new Map<string, string>(),
  idToContainerName: new Map<string, string>(),
});

const registerContainer = (
  state: StructurizrLoadState,
  sourceId: string,
  element: Element,
): void => {
  state.containers.push(element);
  state.idToName.set(sourceId, element.name);
  state.idToContainerName.set(sourceId, element.name);
};

const registerBoundary = (
  state: StructurizrLoadState,
  sourceId: string,
  boundary: Boundary,
  options?: { readonly root?: boolean },
): void => {
  state.boundaries.push(boundary);
  if (options?.root) state.rootBoundaryNames.push(boundary.name);
  state.idToName.set(sourceId, boundary.name);
};

const loadPeople = (
  workspace: StructurizrWorkspace,
  state: StructurizrLoadState,
): void => {
  for (const person of workspace.model.people ?? []) {
    registerContainer(state, person.id, buildPersonContainer(person));
  }
};

const loadLeafSystem = (
  state: StructurizrLoadState,
  system: StructurizrSoftwareSystem,
): void => {
  const container = isExternal(system)
    ? buildExternalSystemContainer(system)
    : buildInternalSystemContainer(system);
  registerContainer(state, system.id, container);
};

const loadContainerWithComponents = (
  state: StructurizrLoadState,
  container: StructurizrContainer,
): void => {
  registerBoundary(state, container.id, buildContainerBoundary(container));
  for (const component of container.components ?? []) {
    registerContainer(state, component.id, buildComponent(component));
  }
};

const loadDecomposedSystem = (
  state: StructurizrLoadState,
  system: StructurizrSoftwareSystem,
): void => {
  const childContainers = system.containers ?? [];
  registerBoundary(
    state,
    system.id,
    buildSystemBoundary(system, childContainers),
    {
      root: true,
    },
  );

  for (const container of childContainers) {
    if (hasComponents(container)) {
      loadContainerWithComponents(state, container);
    } else {
      registerContainer(state, container.id, buildContainer(container));
    }
  }
};

const loadSoftwareSystem = (
  state: StructurizrLoadState,
  system: StructurizrSoftwareSystem,
): void => {
  if (isExternal(system) || (system.containers?.length ?? 0) === 0) {
    loadLeafSystem(state, system);
    return;
  }
  loadDecomposedSystem(state, system);
};

const loadSoftwareSystems = (
  workspace: StructurizrWorkspace,
  state: StructurizrLoadState,
): void => {
  for (const system of workspace.model.softwareSystems ?? []) {
    loadSoftwareSystem(state, system);
  }
};

const addRelationSource = (
  out: ElementWithRelations[],
  sourceId: string,
  relationships: readonly StructurizrRelationship[] | undefined,
): void => {
  if (relationships) out.push({ sourceId, relationships });
};

const collectSystemRelationSources = (
  out: ElementWithRelations[],
  system: StructurizrSoftwareSystem,
): void => {
  addRelationSource(out, system.id, system.relationships);
  for (const container of system.containers ?? []) {
    addRelationSource(out, container.id, container.relationships);
    for (const component of container.components ?? []) {
      addRelationSource(out, component.id, component.relationships);
    }
  }
};

const collectElementsWithRelations = (
  workspace: StructurizrWorkspace,
): ElementWithRelations[] => {
  const out: ElementWithRelations[] = [];
  for (const person of workspace.model.people ?? []) {
    addRelationSource(out, person.id, person.relationships);
  }
  for (const system of workspace.model.softwareSystems ?? []) {
    collectSystemRelationSources(out, system);
  }
  return out;
};

const warnBoundarySourceRelationship = (
  state: StructurizrLoadState,
  mappedName: string,
): void => {
  state.loaderIssues.push({
    kind: "loader-warning",
    source: "structurizr",
    code: "boundary-source-relationship-not-represented",
    message: `Relationship from "${mappedName}" is attached to a Structurizr element that maps to a Boundary in aact; Boundary relations are not represented in v3 Model.`,
    element: mappedName,
  });
};

const warnBoundaryTargetRelationship = (
  state: StructurizrLoadState,
  sourceName: string,
  mappedTargetName: string,
): void => {
  state.loaderIssues.push({
    kind: "loader-warning",
    source: "structurizr",
    code: "boundary-target-relationship-not-represented",
    message: `Relationship to "${mappedTargetName}" targets a Structurizr element that maps to a Boundary in aact; Boundary relations are not represented in v3 Model.`,
    element: sourceName,
  });
};

const applyRelationship = (
  state: StructurizrLoadState,
  containersByName: ReadonlyMap<string, Element>,
  sourceName: string,
  rel: StructurizrRelationship,
  out: Relation[],
): void => {
  const mappedTargetName = state.idToName.get(rel.destinationId);
  if (
    mappedTargetName !== undefined &&
    !containersByName.has(mappedTargetName)
  ) {
    warnBoundaryTargetRelationship(state, sourceName, mappedTargetName);
    return;
  }
  const targetName = mappedTargetName ?? rel.destinationId;
  out.push(buildRelation(rel, targetName));
};

const applyRelationsForSource = (
  state: StructurizrLoadState,
  containersByName: Map<string, Element>,
  sourceId: string,
  relationships: readonly StructurizrRelationship[] | undefined,
): void => {
  const authorRelationships = relationships?.filter(
    (rel) => !rel.linkedRelationshipId,
  );
  const sourceName = state.idToContainerName.get(sourceId);
  if (!authorRelationships || authorRelationships.length === 0) return;
  if (!sourceName) {
    const mappedName = state.idToName.get(sourceId);
    if (mappedName !== undefined)
      warnBoundarySourceRelationship(state, mappedName);
    return;
  }

  const source = containersByName.get(sourceName);
  if (!source) return;

  const newRelations: Relation[] = [...source.relations];
  for (const rel of authorRelationships) {
    applyRelationship(state, containersByName, sourceName, rel, newRelations);
  }
  containersByName.set(sourceName, { ...source, relations: newRelations });
};

const applyRelationships = (
  state: StructurizrLoadState,
  elementsWithRelations: readonly ElementWithRelations[],
): Map<string, Element> => {
  const containersByName = new Map<string, Element>(
    state.containers.map((c) => [c.name, c]),
  );
  for (const { sourceId, relationships } of elementsWithRelations) {
    applyRelationsForSource(state, containersByName, sourceId, relationships);
  }
  return containersByName;
};

/**
 * Structurizr workspace.json → Model.
 *
 * Known limitations (документируется в README):
 *  - System-level relations на decomposed internal SoftwareSystems
 *    (которые мапятся в Boundary) surfaced как loader-warning, потому что
 *    Boundary в v3 Model не имеет outgoing relations.
 *  - Tag inheritance (Structurizr auto-наследование "Software System" tag)
 *    отключено — user tags только из workspace.json.
 *  - enrichTagsFromNames эвристика v2 (имя содержит "crud" → tag "repo") убрана.
 *    Solution Architects явно тэгируют контейнеры в DSL.
 */
export const load = async (filePath: string): Promise<LoadResult> => {
  const filepath = path.resolve(filePath);
  // Dispatch on extension. `.dsl` (Structurizr DSL source) goes
  // through the chevrotain parser; `.json` (structurizr-cli output)
  // stays on the existing JSON walker. Solution Architects who edit
  // DSL directly can now point aact at `workspace.dsl` without first
  // compiling through structurizr-cli.
  if (filepath.toLowerCase().endsWith(".dsl")) {
    return loadFromDsl(filepath);
  }
  const data = await fs.readFile(filepath, "utf8");
  const workspace = JSON.parse(data) as StructurizrWorkspace;

  const state = createStructurizrLoadState();
  loadPeople(workspace, state);
  loadSoftwareSystems(workspace, state);

  // Pass 3: relations — push only into Element-mapped sources.
  // Boundary sources can't carry outgoing relations in v3 Model, so make
  // the loss explicit instead of pretending the exported JSON fully loaded.
  const containersByName = applyRelationships(
    state,
    collectElementsWithRelations(workspace),
  );

  return buildModel({
    elements: [...containersByName.values()],
    boundaries: state.boundaries,
    rootBoundaryNames: state.rootBoundaryNames,
    preIssues: state.loaderIssues,
  });
};

/**
 * Read a Structurizr DSL source file directly via the chevrotain
 * parser. Parse errors are surfaced through a thrown Error — the
 * loader contract guarantees a usable Model or an exception. Model
 * issues from the parser's own toModel pass propagate as
 * `LoadResult.issues` for the linter to render.
 */
const loadFromDsl = async (filepath: string): Promise<LoadResult> => {
  const text = await expandDslIncludes(filepath);
  const result = parseSource(text, filepath);
  if (result.parseErrors.length > 0) {
    const summary = result.parseErrors
      .slice(0, 5)
      .map((e) => `  ${e.line ?? "?"}:${e.column ?? "?"} ${e.message}`)
      .join("\n");
    const more =
      result.parseErrors.length > 5
        ? `\n  ...and ${result.parseErrors.length - 5} more.`
        : "";
    throw new Error(
      `Failed to parse Structurizr DSL ${filepath}:\n${summary}${more}`,
    );
  }
  return { model: result.model, issues: result.issues };
};
