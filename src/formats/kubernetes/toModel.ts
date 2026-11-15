import type {
  Boundary,
  Element,
  ElementKind,
  Model,
  ModelIssue,
} from "../../model";
import { buildModel } from "../../model";
import { humanizeName } from "../_shared/humanize";
import { compileImageHeuristic, matchesGlob } from "../_shared/imageHeuristic";
import { parseCsvTags } from "../_shared/tags";
import {
  parseExternalFlag,
  parseSkipFlag,
  resolveAnnotationKeys,
} from "./annotations";
import { classify } from "./classify";
import {
  inferElementKindFromManifest,
  technologyFromManifest,
} from "./inferKind";
import { buildRelationsFor } from "./relations";
import { buildServiceMap } from "./serviceMap";
import type {
  KubernetesLoadOptions,
  ParsedManifest,
  ResolvedOptions,
} from "./types";

/**
 * ParsedManifest[] → C4 Model.
 *
 * Phase B (foundation):
 *  - workload kinds → Element { kind from image heuristic }
 *  - namespace → Boundary { kind: System }, workloads вкладываются в
 *    свой namespace boundary
 *  - aact.* annotation overrides (element name / kind / label /
 *    description / technology / tags / external / link / skip)
 *  - skip patterns + per-resource `aact.skip`
 *  - namespace filter
 *
 * Phase C добавит relations через Service selectors + env-vars +
 * `aact.depends-on`. До тех пор Element.relations = [].
 */

export interface ToModelInput {
  readonly manifests: readonly ParsedManifest[];
  readonly options?: KubernetesLoadOptions;
}

export interface ToModelOutput {
  readonly model: Model;
  readonly issues: readonly ModelIssue[];
}

const VALID_ELEMENT_KINDS = new Set<ElementKind>([
  "Person",
  "System",
  "Container",
  "ContainerDb",
  "ContainerQueue",
  "Component",
  "ComponentDb",
  "ComponentQueue",
]);

const isElementKind = (raw: string): raw is ElementKind =>
  (VALID_ELEMENT_KINDS as ReadonlySet<string>).has(raw);

const resolveOptions = (
  user: KubernetesLoadOptions | undefined,
): ResolvedOptions => {
  return Object.freeze({
    annotations: resolveAnnotationKeys(user),
    namespaces:
      user?.namespaces && user.namespaces.length > 0
        ? Object.freeze([...user.namespaces])
        : undefined,
    skip: Object.freeze([...(user?.skip ?? [])]),
    imageHeuristic: compileImageHeuristic(user?.imageHeuristic),
  });
};

const isSkipped = (
  manifest: ParsedManifest,
  resolved: ResolvedOptions,
): boolean => {
  if (parseSkipFlag(manifest.metadata.annotations[resolved.annotations.skip])) {
    return true;
  }
  for (const pattern of resolved.skip) {
    if (matchesGlob(manifest.metadata.name, pattern)) return true;
  }
  return false;
};

const isInNamespaceFilter = (
  manifest: ParsedManifest,
  resolved: ResolvedOptions,
): boolean => {
  if (resolved.namespaces === undefined) return true;
  // Manifest без namespace (cluster-scoped или omitted) — включается
  // только если filter содержит "default" ИЛИ namespace опущен.
  const ns = manifest.metadata.namespace ?? "default";
  return resolved.namespaces.includes(ns);
};

/* ------------------------------------------------------------------ */
/*  Element building                                                  */
/* ------------------------------------------------------------------ */

const deriveElementName = (
  manifest: ParsedManifest,
  resolved: ResolvedOptions,
): string => {
  const annot = manifest.metadata.annotations;
  return annot[resolved.annotations.element]?.trim() ?? manifest.metadata.name;
};

const buildElement = (
  manifest: ParsedManifest,
  resolved: ResolvedOptions,
  relations: readonly import("../../model").Relation[],
): Element => {
  const annot = manifest.metadata.annotations;
  const keys = resolved.annotations;

  const elementName = deriveElementName(manifest, resolved);
  const label = annot[keys.label]?.trim() || humanizeName(elementName);
  const description = annot[keys.description] ?? "";
  const technology =
    annot[keys.technology]?.trim() || technologyFromManifest(manifest);
  const external = parseExternalFlag(annot[keys.external]);
  const link = annot[keys.link];
  const tags = parseCsvTags(annot[keys.tags] ?? "");

  const kindOverride = annot[keys.kind]?.trim();
  const kind: ElementKind =
    kindOverride && isElementKind(kindOverride)
      ? kindOverride
      : inferElementKindFromManifest(manifest, resolved.imageHeuristic);

  return Object.freeze({
    name: elementName,
    label,
    kind,
    external,
    description,
    ...(technology ? { technology } : {}),
    tags: Object.freeze(tags),
    relations: Object.freeze([...relations]),
    ...(link && link.length > 0 ? { link } : {}),
    ...(manifest.sourceLocation
      ? { sourceLocation: manifest.sourceLocation }
      : {}),
  } satisfies Element);
};

/* ------------------------------------------------------------------ */
/*  Namespace → Boundary                                              */
/* ------------------------------------------------------------------ */

const buildNamespaceBoundary = (
  namespace: string,
  elementNames: readonly string[],
): Boundary =>
  Object.freeze({
    name: namespace,
    label: humanizeName(namespace),
    kind: "System",
    tags: Object.freeze([]),
    elementNames: Object.freeze([...elementNames]),
    boundaryNames: Object.freeze([]),
  });

/* ------------------------------------------------------------------ */
/*  Orchestration                                                     */
/* ------------------------------------------------------------------ */

export const toModel = (input: ToModelInput): ToModelOutput => {
  const resolved = resolveOptions(input.options);
  const issues: ModelIssue[] = [];

  const workloads = input.manifests.filter((m) => classify(m) === "workload");
  const visible = workloads.filter(
    (m) => isInNamespaceFilter(m, resolved) && !isSkipped(m, resolved),
  );

  // Pre-pass: derive element name для каждого visible workload'а, чтобы
  // serviceMap резолвил selector → element name (не raw metadata.name).
  // Это нужно потому что aact.element annotation может переименовать.
  const workloadElementNames = new Map<ParsedManifest, string>();
  const dedupedManifests: ParsedManifest[] = [];
  const seenNames = new Set<string>();
  for (const manifest of visible) {
    const name = deriveElementName(manifest, resolved);
    if (seenNames.has(name)) {
      issues.push({
        kind: "loader-warning",
        source: "kubernetes",
        code: "duplicate-element",
        message: `Duplicate element "${name}" — ${manifest.kind} at ${manifest.filePath} ignored.`,
        element: name,
      });
      continue;
    }
    seenNames.add(name);
    workloadElementNames.set(manifest, name);
    dedupedManifests.push(manifest);
  }

  const serviceMap = buildServiceMap(input.manifests, workloadElementNames);

  const elements: Element[] = [];
  const namespaceMembers = new Map<string, string[]>();

  for (const manifest of dedupedManifests) {
    const name = workloadElementNames.get(manifest);
    if (name === undefined) continue;
    const relations = buildRelationsFor(
      manifest,
      name,
      serviceMap,
      resolved.annotations,
    );
    const element = buildElement(manifest, resolved, relations);
    elements.push(element);

    // Только если namespace явно задан — группируем в Boundary.
    // Cluster-scoped или namespace-omitted workloads остаются на root.
    if (manifest.metadata.namespace !== undefined) {
      const ns = manifest.metadata.namespace;
      const members = namespaceMembers.get(ns) ?? [];
      members.push(element.name);
      namespaceMembers.set(ns, members);
    }
  }

  const boundaries: Boundary[] = [];
  const rootBoundaryNames: string[] = [];
  for (const [ns, members] of [...namespaceMembers.entries()].toSorted(
    ([a], [b]) => a.localeCompare(b),
  )) {
    boundaries.push(buildNamespaceBoundary(ns, members));
    rootBoundaryNames.push(ns);
  }

  const built = buildModel({ elements, boundaries, rootBoundaryNames });
  return {
    model: built.model,
    issues: [...built.issues, ...issues],
  };
};
