import type {
  Boundary,
  Element,
  Model,
  Relation,
  WorkspaceMetadata,
} from "../model";
import { meaningfulTags } from "../model";
import { hungarian } from "./hungarian";
import { boundarySimilarity, elementSimilarity } from "./similarity";
import type {
  BoundaryChange,
  Change,
  ChangeAction,
  ChangeGroup,
  ChangeSeverity,
  DiffData,
  DiffOptions,
  DiffSide,
  DiffSummary,
  ElementChange,
  FieldChange,
  FieldKind,
  JsonPatchOp,
  RelationChange,
  WorkspaceChange,
} from "./types";

/**
 * Pure structural-diff engine for two normalized C4 Models. CLI
 * wrappers around this live in `src/cli/commands/diff/`; the
 * algorithm itself stays at the model layer so library users can
 * compute diffs without booting the CLI surface.
 *
 * Algorithm in four passes (no side effects, no I/O):
 *
 *  1. Element / Boundary / Relation identity match — name-based for
 *     elements / boundaries, `(from, to, technology)` tuple for
 *     relations. Matched pairs land in `modified` with per-field
 *     deltas; unmatched go to `added` / `removed`.
 *  2. Rename detection — for each removed/added pair of the same
 *     `kind`, compute multi-feature similarity (`./similarity.ts`),
 *     build a cost matrix, run Hungarian (`./hungarian.ts`) for
 *     globally-optimal assignment, threshold-filter (default 0.65).
 *     Wrapped in a monotonic fixed-point loop so chain renames
 *     converge — the leaf's rename feeds back into the
 *     middle-of-chain's relation jaccard, which then crosses
 *     threshold for the head.
 *  3. Relation diff with rename remap — `Relation.to` strings on
 *     the baseline side are rewritten through the renameMap from
 *     pass 2 before identity matching, so edges touching renamed
 *     elements still match their post-rename counterparts.
 *  4. Relation pair-collapse — `(from, to)` groups with exactly one
 *     removed and one added entry mean the technology was swapped
 *     in place; surface as `modified` with `field: "technology"`,
 *     not noisy add+remove pair. Easier to read on PR review.
 *
 * Sorting: severity desc → action precedence → address asc. First
 * entries of `changes[]` are always the highest-impact ones.
 */

// -----------------------------------------------------------------------------
// Utility helpers
// -----------------------------------------------------------------------------

const ACTION_PRECEDENCE: Record<ChangeAction, number> = {
  removed: 0,
  added: 1,
  modified: 2,
  renamed: 3,
  moved: 4,
};

const SEVERITY_PRECEDENCE: Record<ChangeSeverity, number> = {
  structural: 0,
  semantic: 1,
  cosmetic: 2,
};

export const DEFAULT_RENAME_THRESHOLD = 0.65;

const FIELD_SEVERITY: Record<FieldKind, ChangeSeverity> = {
  kind: "structural",
  external: "semantic",
  technology: "semantic",
  description: "cosmetic",
  label: "cosmetic",
  tags: "semantic",
  sprite: "cosmetic",
  link: "cosmetic",
  properties: "semantic",
  boundary: "structural",
  order: "semantic",
  "workspace.name": "cosmetic",
  "workspace.description": "cosmetic",
  "workspace.extendsTarget": "cosmetic",
  elementNames: "structural",
  boundaryNames: "structural",
};

const aggregateSeverity = (fields: readonly FieldChange[]): ChangeSeverity => {
  let max: ChangeSeverity = "cosmetic";
  for (const f of fields) {
    const sev = FIELD_SEVERITY[f.field];
    if (SEVERITY_PRECEDENCE[sev] < SEVERITY_PRECEDENCE[max]) max = sev;
  }
  return max;
};

const normTech = (t: string | undefined): string => (t ?? "").trim();

const stringArraysEqual = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean => {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  const setB = new Set(bb);
  return aa.every((x) => setB.has(x));
};

const setDelta = (
  before: readonly string[] | undefined,
  after: readonly string[] | undefined,
): { added: string[]; removed: string[] } => {
  const beforeSet = new Set(before ?? []);
  const afterSet = new Set(after ?? []);
  const added: string[] = [];
  const removed: string[] = [];
  for (const x of afterSet) if (!beforeSet.has(x)) added.push(x);
  for (const x of beforeSet) if (!afterSet.has(x)) removed.push(x);
  return { added, removed };
};

const propertiesEqual = (
  a: Readonly<Record<string, string>> | undefined,
  b: Readonly<Record<string, string>> | undefined,
): boolean => {
  const compare = (x: string, y: string): number => x.localeCompare(y);
  const aKeys = Object.keys(a ?? {}).sort(compare);
  const bKeys = Object.keys(b ?? {}).sort(compare);
  if (aKeys.length !== bKeys.length) return false;
  for (const [i, key] of aKeys.entries()) {
    if (key !== bKeys[i]) return false;
    if ((a ?? {})[key] !== (b ?? {})[key]) return false;
  }
  return true;
};

// -----------------------------------------------------------------------------
// Rename detection — Hungarian assignment over multi-feature similarity
// -----------------------------------------------------------------------------
//
// Similarity functions live in `./similarity.ts` (multi-feature, hand-tuned
// weights, documented). The detector here is the matching machinery: build
// a cost matrix from the similarity function, hand it to Hungarian for a
// globally-optimal assignment, threshold-filter the result.
//
// `INFEASIBLE` is the cost we assign to forbidden cells (cross-kind, or
// similarity below threshold). Hungarian treats `+Infinity` as "cannot
// match" and leaves the row unassigned.

interface RenamePair<T> {
  readonly removed: T;
  readonly added: T;
  readonly confidence: number;
}

const detectRenames = <T>(
  removed: readonly T[],
  added: readonly T[],
  similarity: (a: T, b: T) => number,
  threshold: number,
): RenamePair<T>[] => {
  if (removed.length === 0 || added.length === 0) return [];
  // Build cost matrix: cost = 1 - similarity for feasible pairs,
  // +Infinity for pairs below the threshold. Hungarian then picks
  // the globally optimal assignment that minimises total cost
  // (= maximises total similarity).
  const cost: number[][] = removed.map((r) =>
    added.map((a) => {
      const s = similarity(r, a);
      return s >= threshold ? 1 - s : Number.POSITIVE_INFINITY;
    }),
  );
  const { assignment } = hungarian(cost);
  const pairs: RenamePair<T>[] = [];
  for (const [i, j] of assignment.entries()) {
    if (j === undefined) continue;
    pairs.push({
      removed: removed[i],
      added: added[j],
      confidence: 1 - cost[i][j],
    });
  }
  return pairs;
};

/**
 * Fixed-point rename detection for elements. Runs `detectRenames`
 * repeatedly, feeding the accumulated `renameMap` back into the
 * similarity function so chain renames converge — when the leaf of
 * a chain is detected first, its rename re-keys relation targets
 * for the middle pair's scoring, which then crosses threshold for
 * the head pair's scoring.
 *
 * Monotonic: each iteration only ADDS pairs. Termination is
 * guaranteed by the strictly-decreasing unmatched set, but we cap at
 * `MAX_ITERATIONS` defensively in case future similarity changes
 * introduce oscillation under bipartite re-optimisation. Chains
 * longer than 5 elements are rare enough that this cap is safe.
 *
 * `renameMap` is mutated in place — the caller relies on the
 * post-iteration state for downstream relation diffing.
 */
const MAX_RENAME_ITERATIONS = 5;

const iterativeRenameDetection = (
  removed: readonly Element[],
  added: readonly Element[],
  renameMap: Map<string, string>,
  threshold: number,
): RenamePair<Element>[] => {
  const allPairs: RenamePair<Element>[] = [];
  let unmatchedRemoved: Element[] = [...removed];
  let unmatchedAdded: Element[] = [...added];

  for (let iter = 0; iter < MAX_RENAME_ITERATIONS; iter++) {
    if (unmatchedRemoved.length === 0 || unmatchedAdded.length === 0) break;
    const sim = (a: Element, b: Element): number =>
      elementSimilarity(a, b, { renameMap });
    const pairs = detectRenames(
      unmatchedRemoved,
      unmatchedAdded,
      sim,
      threshold,
    );
    if (pairs.length === 0) break;
    for (const pair of pairs) {
      renameMap.set(pair.removed.name, pair.added.name);
      allPairs.push(pair);
    }
    const takenRemoved = new Set(pairs.map((p) => p.removed));
    const takenAdded = new Set(pairs.map((p) => p.added));
    unmatchedRemoved = unmatchedRemoved.filter((e) => !takenRemoved.has(e));
    unmatchedAdded = unmatchedAdded.filter((e) => !takenAdded.has(e));
  }
  return allPairs;
};

// -----------------------------------------------------------------------------
// Per-entity diff
// -----------------------------------------------------------------------------

const diffElementFields = (
  before: Element,
  after: Element,
  boundaryBefore: string | undefined,
  boundaryAfter: string | undefined,
): FieldChange[] => {
  const fields: FieldChange[] = [];
  if (before.kind !== after.kind) {
    fields.push({ field: "kind", before: before.kind, after: after.kind });
  }
  if (before.external !== after.external) {
    fields.push({
      field: "external",
      before: before.external,
      after: after.external,
    });
  }
  if (normTech(before.technology) !== normTech(after.technology)) {
    fields.push({
      field: "technology",
      before: before.technology,
      after: after.technology,
    });
  }
  if (before.label !== after.label) {
    fields.push({ field: "label", before: before.label, after: after.label });
  }
  if (before.description !== after.description) {
    fields.push({
      field: "description",
      before: before.description,
      after: after.description,
    });
  }
  const beforeTags = meaningfulTags(before.tags);
  const afterTags = meaningfulTags(after.tags);
  if (!stringArraysEqual(beforeTags, afterTags)) {
    const delta = setDelta(beforeTags, afterTags);
    fields.push({
      field: "tags",
      before: beforeTags,
      after: afterTags,
      ...(delta.added.length > 0 ? { added: delta.added } : {}),
      ...(delta.removed.length > 0 ? { removed: delta.removed } : {}),
    });
  }
  if (before.sprite !== after.sprite) {
    fields.push({
      field: "sprite",
      before: before.sprite,
      after: after.sprite,
    });
  }
  if (before.link !== after.link) {
    fields.push({ field: "link", before: before.link, after: after.link });
  }
  if (!propertiesEqual(before.properties, after.properties)) {
    fields.push({
      field: "properties",
      before: before.properties,
      after: after.properties,
    });
  }
  if (boundaryBefore !== boundaryAfter) {
    fields.push({
      field: "boundary",
      before: boundaryBefore,
      after: boundaryAfter,
    });
  }
  return fields;
};

/**
 * Optional free-text fields: an absent value and an empty string say the
 * same thing. PlantUML `Rel(a, b, "")` loads as `undefined` while a
 * hand-written or adapter-emitted Model carries `""` — comparing them
 * strictly reported a phantom cosmetic change on every such relation.
 */
const sameOptionalText = (
  before: string | undefined,
  after: string | undefined,
): boolean => (before ?? "") === (after ?? "");

const diffBoundaryFields = (
  before: Boundary,
  after: Boundary,
): FieldChange[] => {
  const fields: FieldChange[] = [];
  if (before.kind !== after.kind) {
    fields.push({ field: "kind", before: before.kind, after: after.kind });
  }
  if (before.label !== after.label) {
    fields.push({ field: "label", before: before.label, after: after.label });
  }
  if (!sameOptionalText(before.description, after.description)) {
    fields.push({
      field: "description",
      before: before.description,
      after: after.description,
    });
  }
  const beforeTags = meaningfulTags(before.tags);
  const afterTags = meaningfulTags(after.tags);
  if (!stringArraysEqual(beforeTags, afterTags)) {
    const delta = setDelta(beforeTags, afterTags);
    fields.push({
      field: "tags",
      before: beforeTags,
      after: afterTags,
      ...(delta.added.length > 0 ? { added: delta.added } : {}),
      ...(delta.removed.length > 0 ? { removed: delta.removed } : {}),
    });
  }
  if (!stringArraysEqual(before.elementNames, after.elementNames)) {
    const delta = setDelta(before.elementNames, after.elementNames);
    fields.push({
      field: "elementNames",
      before: before.elementNames,
      after: after.elementNames,
      ...(delta.added.length > 0 ? { added: delta.added } : {}),
      ...(delta.removed.length > 0 ? { removed: delta.removed } : {}),
    });
  }
  if (!stringArraysEqual(before.boundaryNames, after.boundaryNames)) {
    const delta = setDelta(before.boundaryNames, after.boundaryNames);
    fields.push({
      field: "boundaryNames",
      before: before.boundaryNames,
      after: after.boundaryNames,
      ...(delta.added.length > 0 ? { added: delta.added } : {}),
      ...(delta.removed.length > 0 ? { removed: delta.removed } : {}),
    });
  }
  if (before.link !== after.link) {
    fields.push({ field: "link", before: before.link, after: after.link });
  }
  if (!propertiesEqual(before.properties, after.properties)) {
    fields.push({
      field: "properties",
      before: before.properties,
      after: after.properties,
    });
  }
  return fields;
};

const diffRelationFields = (
  before: Relation,
  after: Relation,
): FieldChange[] => {
  const fields: FieldChange[] = [];
  if (!sameOptionalText(before.description, after.description)) {
    fields.push({
      field: "description",
      before: before.description,
      after: after.description,
    });
  }
  const beforeTags = meaningfulTags(before.tags);
  const afterTags = meaningfulTags(after.tags);
  if (!stringArraysEqual(beforeTags, afterTags)) {
    const delta = setDelta(beforeTags, afterTags);
    fields.push({
      field: "tags",
      before: beforeTags,
      after: afterTags,
      ...(delta.added.length > 0 ? { added: delta.added } : {}),
      ...(delta.removed.length > 0 ? { removed: delta.removed } : {}),
    });
  }
  if (before.order !== after.order) {
    fields.push({ field: "order", before: before.order, after: after.order });
  }
  if (!propertiesEqual(before.properties, after.properties)) {
    fields.push({
      field: "properties",
      before: before.properties,
      after: after.properties,
    });
  }
  return fields;
};

// -----------------------------------------------------------------------------
// Address helpers
// -----------------------------------------------------------------------------

const elementAddress = (name: string): string => `element:${name}`;
const boundaryAddress = (name: string): string => `boundary:${name}`;
const relationAddress = (from: string, to: string, tech?: string): string =>
  tech ? `relation:${from}→${to}(${tech})` : `relation:${from}→${to}`;
const workspaceAddress = (): string => "workspace";

const groupId = (kind: string, ...parts: readonly string[]): string =>
  ["group", kind, ...parts]
    .map((p) => p.replaceAll(/[^a-zA-Z0-9._-]+/g, "_"))
    .join(":");

// -----------------------------------------------------------------------------
// Boundary index (which boundary owns each element name?)
// -----------------------------------------------------------------------------

const buildElementBoundaryMap = (model: Model): Map<string, string> => {
  const out = new Map<string, string>();
  for (const b of Object.values(model.boundaries)) {
    for (const n of b.elementNames) out.set(n, b.name);
  }
  return out;
};

// -----------------------------------------------------------------------------
// Element diff
// -----------------------------------------------------------------------------

const diffElements = (
  baseline: Model,
  current: Model,
  options: DiffOptions,
): { changes: ElementChange[]; renameMap: Map<string, string> } => {
  const changes: ElementChange[] = [];
  const renameMap = new Map<string, string>();
  const baselineBoundaries = buildElementBoundaryMap(baseline);
  const currentBoundaries = buildElementBoundaryMap(current);

  const baselineNames = new Set(Object.keys(baseline.elements));
  const currentNames = new Set(Object.keys(current.elements));

  const removed: Element[] = [];
  const added: Element[] = [];
  for (const name of baselineNames) {
    if (!currentNames.has(name)) removed.push(baseline.elements[name]);
  }
  for (const name of currentNames) {
    if (!baselineNames.has(name)) added.push(current.elements[name]);
  }

  const threshold = options.renameThreshold ?? DEFAULT_RENAME_THRESHOLD;
  const renamePairs: RenamePair<Element>[] = options.disableRenameDetection
    ? []
    : iterativeRenameDetection(removed, added, renameMap, threshold);
  const renamedRemoved = new Set(renamePairs.map((p) => p.removed));
  const renamedAdded = new Set(renamePairs.map((p) => p.added));

  for (const pair of renamePairs) {
    const fields = diffElementFields(
      pair.removed,
      pair.added,
      baselineBoundaries.get(pair.removed.name),
      currentBoundaries.get(pair.added.name),
    );
    // Rename itself is structural — name change is the load-bearing
    // signal, regardless of which other fields moved.
    changes.push({
      entity: "element",
      action: "renamed",
      severity: "structural",
      address: elementAddress(pair.added.name),
      name: pair.added.name,
      previousName: pair.removed.name,
      confidence: pair.confidence,
      kind: pair.added.kind,
      fields,
    });
  }

  for (const el of removed) {
    if (renamedRemoved.has(el)) continue;
    changes.push({
      entity: "element",
      action: "removed",
      severity: "structural",
      address: elementAddress(el.name),
      name: el.name,
      kind: el.kind,
      fields: [],
    });
  }
  for (const el of added) {
    if (renamedAdded.has(el)) continue;
    changes.push({
      entity: "element",
      action: "added",
      severity: "structural",
      address: elementAddress(el.name),
      name: el.name,
      kind: el.kind,
      fields: [],
    });
  }

  // Matched (same name in both) — diff per field.
  for (const name of baselineNames) {
    if (!currentNames.has(name)) continue;
    const before = baseline.elements[name];
    const after = current.elements[name];
    const fields = diffElementFields(
      before,
      after,
      baselineBoundaries.get(name),
      currentBoundaries.get(name),
    );
    if (fields.length === 0) continue;
    const hasBoundaryMove = fields.some((f) => f.field === "boundary");
    changes.push({
      entity: "element",
      action: hasBoundaryMove && fields.length === 1 ? "moved" : "modified",
      severity: aggregateSeverity(fields),
      address: elementAddress(name),
      name,
      kind: after.kind,
      fields,
    });
  }
  return { changes, renameMap };
};

// -----------------------------------------------------------------------------
// Boundary diff
// -----------------------------------------------------------------------------

const diffBoundaries = (
  baseline: Model,
  current: Model,
  options: DiffOptions,
): BoundaryChange[] => {
  const changes: BoundaryChange[] = [];
  const baselineNames = new Set(Object.keys(baseline.boundaries));
  const currentNames = new Set(Object.keys(current.boundaries));

  const removed: Boundary[] = [];
  const added: Boundary[] = [];
  for (const name of baselineNames) {
    if (!currentNames.has(name)) removed.push(baseline.boundaries[name]);
  }
  for (const name of currentNames) {
    if (!baselineNames.has(name)) added.push(current.boundaries[name]);
  }

  const renamePairs: RenamePair<Boundary>[] = options.disableRenameDetection
    ? []
    : detectRenames(
        removed,
        added,
        boundarySimilarity,
        options.renameThreshold ?? DEFAULT_RENAME_THRESHOLD,
      );
  const renamedRemoved = new Set(renamePairs.map((p) => p.removed));
  const renamedAdded = new Set(renamePairs.map((p) => p.added));

  for (const pair of renamePairs) {
    const fields = diffBoundaryFields(pair.removed, pair.added);
    changes.push({
      entity: "boundary",
      action: "renamed",
      severity: "structural",
      address: boundaryAddress(pair.added.name),
      name: pair.added.name,
      previousName: pair.removed.name,
      confidence: pair.confidence,
      kind: pair.added.kind,
      fields,
    });
  }

  for (const b of removed) {
    if (renamedRemoved.has(b)) continue;
    changes.push({
      entity: "boundary",
      action: "removed",
      severity: "structural",
      address: boundaryAddress(b.name),
      name: b.name,
      kind: b.kind,
      fields: [],
    });
  }
  for (const b of added) {
    if (renamedAdded.has(b)) continue;
    changes.push({
      entity: "boundary",
      action: "added",
      severity: "structural",
      address: boundaryAddress(b.name),
      name: b.name,
      kind: b.kind,
      fields: [],
    });
  }

  for (const name of baselineNames) {
    if (!currentNames.has(name)) continue;
    const before = baseline.boundaries[name];
    const after = current.boundaries[name];
    const fields = diffBoundaryFields(before, after);
    if (fields.length === 0) continue;
    changes.push({
      entity: "boundary",
      action: "modified",
      severity: aggregateSeverity(fields),
      address: boundaryAddress(name),
      name,
      kind: after.kind,
      fields,
    });
  }
  return changes;
};

// -----------------------------------------------------------------------------
// Relation diff
// -----------------------------------------------------------------------------

interface IndexedRelation {
  readonly from: string;
  readonly rel: Relation;
  readonly id: string;
}

const indexRelations = (model: Model): IndexedRelation[] => {
  const out: IndexedRelation[] = [];
  for (const el of Object.values(model.elements)) {
    for (const rel of el.relations) {
      const tech = normTech(rel.technology);
      out.push({
        from: el.name,
        rel,
        id: tech ? `${el.name}\0${rel.to}\0${tech}` : `${el.name}\0${rel.to}\0`,
      });
    }
  }
  return out;
};

const remapRelationId = (
  r: IndexedRelation,
  renameMap: ReadonlyMap<string, string>,
): string => {
  const newFrom = renameMap.get(r.from) ?? r.from;
  const newTo = renameMap.get(r.rel.to) ?? r.rel.to;
  const tech = normTech(r.rel.technology);
  return tech ? `${newFrom}\0${newTo}\0${tech}` : `${newFrom}\0${newTo}\0`;
};

const diffRelations = (
  baseline: Model,
  current: Model,
  /** old-name → new-name map from rename detection, so relations
   *  touching renamed elements match the new names. */
  renameMap: ReadonlyMap<string, string> = new Map(),
): RelationChange[] => {
  const baselineRels = indexRelations(baseline);
  const currentRels = indexRelations(current);

  // Multiset matching: when the same (from, to, technology) triple
  // appears multiple times on either side, pair them by index so
  // duplicates survive instead of getting Map-overwritten. Important
  // for Dynamic-view sequences and any model that legitimately
  // repeats an edge.
  const baselineByRemappedId = new Map<string, IndexedRelation[]>();
  for (const r of baselineRels) {
    const remappedId = remapRelationId(r, renameMap);
    const bucket = baselineByRemappedId.get(remappedId);
    if (bucket) bucket.push(r);
    else baselineByRemappedId.set(remappedId, [r]);
  }
  const currentById = new Map<string, IndexedRelation[]>();
  for (const r of currentRels) {
    const bucket = currentById.get(r.id);
    if (bucket) bucket.push(r);
    else currentById.set(r.id, [r]);
  }

  const removed: IndexedRelation[] = [];
  const added: IndexedRelation[] = [];
  const modified: RelationChange[] = [];

  // Identity match by remapped (from, to, technology); pair by
  // bucket index so duplicates survive.
  for (const [remappedId, baseBucket] of baselineByRemappedId) {
    const currBucket = currentById.get(remappedId) ?? [];
    const matchCount = Math.min(baseBucket.length, currBucket.length);
    for (let i = 0; i < matchCount; i++) {
      const r = baseBucket[i];
      const match = currBucket[i];
      const fields = diffRelationFields(r.rel, match.rel);
      if (fields.length > 0) {
        modified.push({
          entity: "relation",
          action: "modified",
          severity: aggregateSeverity(fields),
          address: relationAddress(
            match.from,
            match.rel.to,
            normTech(match.rel.technology) || undefined,
          ),
          from: match.from,
          to: match.rel.to,
          ...(match.rel.technology ? { technology: match.rel.technology } : {}),
          fields,
        });
      }
    }
    for (let i = matchCount; i < baseBucket.length; i++) {
      removed.push(baseBucket[i]);
    }
  }
  for (const [id, currBucket] of currentById) {
    const matched = baselineByRemappedId.get(id)?.length ?? 0;
    for (let i = matched; i < currBucket.length; i++) added.push(currBucket[i]);
  }

  // Pair-collapse: same (from, to) with exactly one removed + one
  // added → "technology swapped in place", surface as modified. We
  // remap baseline-side keys through the rename map so a relation
  // touching a renamed element still pairs with its current-side
  // counterpart instead of looking like a stale add+remove.
  const removedByPair = new Map<string, IndexedRelation[]>();
  const addedByPair = new Map<string, IndexedRelation[]>();
  const pairKey = (r: IndexedRelation): string => `${r.from}\0${r.rel.to}`;
  const remappedPairKey = (r: IndexedRelation): string => {
    const newFrom = renameMap.get(r.from) ?? r.from;
    const newTo = renameMap.get(r.rel.to) ?? r.rel.to;
    return `${newFrom}\0${newTo}`;
  };
  for (const r of removed) {
    const k = remappedPairKey(r);
    const list = removedByPair.get(k);
    if (list) list.push(r);
    else removedByPair.set(k, [r]);
  }
  for (const r of added) {
    const k = pairKey(r);
    const list = addedByPair.get(k);
    if (list) list.push(r);
    else addedByPair.set(k, [r]);
  }
  const collapsedRemoved = new Set<IndexedRelation>();
  const collapsedAdded = new Set<IndexedRelation>();
  for (const [k, rems] of removedByPair) {
    const adds = addedByPair.get(k);
    if (!adds) continue;
    if (rems.length !== 1 || adds.length !== 1) continue;
    const r = rems[0];
    const a = adds[0];
    const fields: FieldChange[] = [
      {
        field: "technology",
        before: r.rel.technology,
        after: a.rel.technology,
      },
      ...diffRelationFields(r.rel, a.rel),
    ];
    // Use the current-side names — when the source/target was
    // renamed, the collapsed entry should reflect the new name.
    modified.push({
      entity: "relation",
      action: "modified",
      severity: aggregateSeverity(fields),
      address: relationAddress(a.from, a.rel.to),
      from: a.from,
      to: a.rel.to,
      ...(a.rel.technology ? { technology: a.rel.technology } : {}),
      fields,
    });
    collapsedRemoved.add(r);
    collapsedAdded.add(a);
  }

  const result: RelationChange[] = [...modified];
  for (const r of removed) {
    if (collapsedRemoved.has(r)) continue;
    result.push({
      entity: "relation",
      action: "removed",
      severity: "structural",
      address: relationAddress(
        r.from,
        r.rel.to,
        normTech(r.rel.technology) || undefined,
      ),
      from: r.from,
      to: r.rel.to,
      ...(r.rel.technology ? { technology: r.rel.technology } : {}),
      fields: [],
    });
  }
  for (const r of added) {
    if (collapsedAdded.has(r)) continue;
    result.push({
      entity: "relation",
      action: "added",
      severity: "structural",
      address: relationAddress(
        r.from,
        r.rel.to,
        normTech(r.rel.technology) || undefined,
      ),
      from: r.from,
      to: r.rel.to,
      ...(r.rel.technology ? { technology: r.rel.technology } : {}),
      fields: [],
    });
  }
  return result;
};

// -----------------------------------------------------------------------------
// Workspace diff
// -----------------------------------------------------------------------------

const diffWorkspace = (
  baseline: WorkspaceMetadata | undefined,
  current: WorkspaceMetadata | undefined,
): WorkspaceChange[] => {
  const fields: FieldChange[] = [];
  if ((baseline?.name ?? "") !== (current?.name ?? "")) {
    fields.push({
      field: "workspace.name",
      before: baseline?.name,
      after: current?.name,
    });
  }
  if ((baseline?.description ?? "") !== (current?.description ?? "")) {
    fields.push({
      field: "workspace.description",
      before: baseline?.description,
      after: current?.description,
    });
  }
  if ((baseline?.extendsTarget ?? "") !== (current?.extendsTarget ?? "")) {
    fields.push({
      field: "workspace.extendsTarget",
      before: baseline?.extendsTarget,
      after: current?.extendsTarget,
    });
  }
  if (fields.length === 0) return [];
  return [
    {
      entity: "workspace",
      action: "modified",
      severity: aggregateSeverity(fields),
      address: workspaceAddress(),
      fields,
    },
  ];
};

// -----------------------------------------------------------------------------
// Change groups — deterministic architectural interpretations over primitives
// -----------------------------------------------------------------------------

const stringifyEvidence = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const elementSearchText = (el: Element | undefined): string => {
  if (!el) return "";
  const props = Object.entries(el.properties ?? {}).flatMap(([k, v]) => [k, v]);
  return [
    el.name,
    el.label,
    el.description,
    el.technology,
    ...el.tags,
    ...props,
  ]
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .join(" ")
    .toLowerCase();
};

const isRepositoryLike = (el: Element | undefined): boolean => {
  if (!el) return false;
  const name = el.name.toLowerCase();
  const text = elementSearchText(el);
  return (
    name.endsWith("repo") ||
    name.endsWith("repository") ||
    /\brepo\b/.test(text) ||
    /\brepository\b/.test(text)
  );
};

const isDatabaseLike = (el: Element | undefined): boolean => {
  if (!el) return false;
  if (el.kind.endsWith("Db")) return true;
  const text = elementSearchText(el);
  return (
    /\bdb\b/.test(text) ||
    /\bdatabase\b/.test(text) ||
    /\bpostgres(?:ql)?\b/.test(text) ||
    /\bmysql\b/.test(text) ||
    /\bmariadb\b/.test(text) ||
    /\bmongo(?:db)?\b/.test(text) ||
    /\bcockroach(?:db)?\b/.test(text) ||
    /\bdynamo(?:db)?\b/.test(text)
  );
};

const maxSeverity = (changes: readonly Change[]): ChangeSeverity => {
  let max: ChangeSeverity = "cosmetic";
  for (const change of changes) {
    if (SEVERITY_PRECEDENCE[change.severity] < SEVERITY_PRECEDENCE[max]) {
      max = change.severity;
    }
  }
  return max;
};

const detectTechnologySwappedGroups = (
  changes: readonly Change[],
): ChangeGroup[] => {
  const groups: ChangeGroup[] = [];
  for (const change of changes) {
    if (change.entity !== "relation") continue;
    if (change.action !== "modified") continue;
    const tech = change.fields.find((f) => f.field === "technology");
    if (!tech) continue;
    const before = stringifyEvidence(tech.before) ?? "none";
    const after = stringifyEvidence(tech.after) ?? "none";
    groups.push({
      id: groupId("technologySwapped", change.from, change.to, before, after),
      kind: "technologySwapped",
      title: `${change.from} → ${change.to} technology changed from ${before} to ${after}`,
      severity: change.severity,
      confidence: 1,
      changeAddresses: [change.address],
      evidence: {
        from: change.from,
        to: change.to,
        beforeTechnology: before,
        afterTechnology: after,
      },
    });
  }
  return groups;
};

const detectIntroducedRepositoryGroups = (
  changes: readonly Change[],
  baseline: Model,
  current: Model,
): ChangeGroup[] => {
  const addedElements = changes.filter(
    (c): c is ElementChange => c.entity === "element" && c.action === "added",
  );
  const addedRelations = changes.filter(
    (c): c is RelationChange => c.entity === "relation" && c.action === "added",
  );
  const removedRelations = changes.filter(
    (c): c is RelationChange =>
      c.entity === "relation" && c.action === "removed",
  );

  const groups: ChangeGroup[] = [];
  const seen = new Set<string>();

  for (const repoChange of addedElements) {
    const repository = current.elements[repoChange.name];
    if (!isRepositoryLike(repository)) continue;

    const serviceToRepo = addedRelations.filter(
      (r) => r.to === repoChange.name && r.from !== repoChange.name,
    );
    const repoToDatabase = addedRelations.filter(
      (r) =>
        r.from === repoChange.name &&
        r.to !== repoChange.name &&
        isDatabaseLike(current.elements[r.to] ?? baseline.elements[r.to]),
    );

    for (const incoming of serviceToRepo) {
      for (const outgoing of repoToDatabase) {
        if (incoming.from === outgoing.to) continue;
        const removed = removedRelations.find(
          (r) => r.from === incoming.from && r.to === outgoing.to,
        );
        if (!removed) continue;

        const id = groupId(
          "introducedRepository",
          incoming.from,
          repoChange.name,
          outgoing.to,
        );
        if (seen.has(id)) continue;
        seen.add(id);

        const groupedChanges = [repoChange, removed, incoming, outgoing];
        groups.push({
          id,
          kind: "introducedRepository",
          title: `Repository layer introduced between ${incoming.from} and ${outgoing.to}`,
          severity: maxSeverity(groupedChanges),
          confidence: 0.95,
          changeAddresses: groupedChanges.map((c) => c.address),
          evidence: {
            service: incoming.from,
            repository: repoChange.name,
            database: outgoing.to,
            removedRelation: removed.address,
            serviceToRepository: incoming.address,
            repositoryToDatabase: outgoing.address,
          },
        });
      }
    }
  }

  return groups;
};

const compareGroups = (a: ChangeGroup, b: ChangeGroup): number => {
  const sevDiff =
    SEVERITY_PRECEDENCE[a.severity] - SEVERITY_PRECEDENCE[b.severity];
  if (sevDiff !== 0) return sevDiff;
  return a.id.localeCompare(b.id);
};

const detectChangeGroups = (
  changes: readonly Change[],
  baseline: Model,
  current: Model,
): ChangeGroup[] =>
  [
    ...detectTechnologySwappedGroups(changes),
    ...detectIntroducedRepositoryGroups(changes, baseline, current),
  ].sort(compareGroups);

// -----------------------------------------------------------------------------
// Summary + sort
// -----------------------------------------------------------------------------

const compareChanges = (a: Change, b: Change): number => {
  const sevDiff =
    SEVERITY_PRECEDENCE[a.severity] - SEVERITY_PRECEDENCE[b.severity];
  if (sevDiff !== 0) return sevDiff;
  const actDiff = ACTION_PRECEDENCE[a.action] - ACTION_PRECEDENCE[b.action];
  if (actDiff !== 0) return actDiff;
  return a.address.localeCompare(b.address);
};

const pickDominantSeverity = (
  bySeverity: DiffSummary["bySeverity"],
): ChangeSeverity => {
  if (bySeverity.structural > 0) return "structural";
  if (bySeverity.semantic > 0) return "semantic";
  return "cosmetic";
};

const buildHeadline = (
  changes: readonly Change[],
  bySeverity: DiffSummary["bySeverity"],
): string => {
  if (changes.length === 0) return "no changes";
  const parts: string[] = [];
  const elements = changes.filter((c) => c.entity === "element");
  const relations = changes.filter((c) => c.entity === "relation");
  const boundaries = changes.filter((c) => c.entity === "boundary");
  const elAdded = elements.filter((c) => c.action === "added").length;
  const elRemoved = elements.filter((c) => c.action === "removed").length;
  const elRenamed = elements.filter((c) => c.action === "renamed").length;
  const relAdded = relations.filter((c) => c.action === "added").length;
  const relRemoved = relations.filter((c) => c.action === "removed").length;
  const bndAdded = boundaries.filter((c) => c.action === "added").length;
  const bndRemoved = boundaries.filter((c) => c.action === "removed").length;
  const techChanges = changes.filter((c) =>
    c.fields.some((f) => f.field === "technology"),
  ).length;
  if (elAdded > 0) parts.push(`+${elAdded} element${elAdded === 1 ? "" : "s"}`);
  if (elRemoved > 0)
    parts.push(`-${elRemoved} element${elRemoved === 1 ? "" : "s"}`);
  if (elRenamed > 0) parts.push(`~${elRenamed} renamed`);
  if (bndAdded > 0)
    parts.push(`+${bndAdded} boundar${bndAdded === 1 ? "y" : "ies"}`);
  if (bndRemoved > 0)
    parts.push(`-${bndRemoved} boundar${bndRemoved === 1 ? "y" : "ies"}`);
  if (relAdded > 0)
    parts.push(`+${relAdded} relation${relAdded === 1 ? "" : "s"}`);
  if (relRemoved > 0)
    parts.push(`-${relRemoved} relation${relRemoved === 1 ? "" : "s"}`);
  if (techChanges > 0)
    parts.push(
      `${techChanges} technology change${techChanges === 1 ? "" : "s"}`,
    );
  if (parts.length === 0) parts.push(`${changes.length} change(s)`);
  const dominantSeverity = pickDominantSeverity(bySeverity);
  return `${parts.join(", ")} [${dominantSeverity}]`;
};

const buildSummary = (changes: readonly Change[]): DiffSummary => {
  const bySeverity: DiffSummary["bySeverity"] = {
    structural: 0,
    semantic: 0,
    cosmetic: 0,
  };
  const byAction: DiffSummary["byAction"] = {
    added: 0,
    removed: 0,
    modified: 0,
    renamed: 0,
    moved: 0,
  };
  const byEntity: DiffSummary["byEntity"] = {
    element: 0,
    boundary: 0,
    relation: 0,
    workspace: 0,
  };
  for (const c of changes) {
    bySeverity[c.severity]++;
    byAction[c.action]++;
    byEntity[c.entity]++;
  }
  return {
    headline: buildHeadline(changes, bySeverity),
    bySeverity,
    byAction,
    byEntity,
  };
};

// -----------------------------------------------------------------------------
// RFC 6902 patch (opt-in)
// -----------------------------------------------------------------------------

const stripElementLocation = (el: Element): Element => {
  const copy: Record<string, unknown> = { ...el };
  delete copy.sourceLocation;
  copy.relations = el.relations.map((r) => {
    const rc: Record<string, unknown> = { ...r };
    delete rc.sourceLocation;
    return rc as unknown as Element["relations"][number];
  });
  return copy as unknown as Element;
};

const stripBoundaryLocation = (b: Boundary): Boundary => {
  const copy: Record<string, unknown> = { ...b };
  delete copy.sourceLocation;
  return copy as unknown as Boundary;
};

const stripSourceLocation = (model: Model): Model => {
  const elements: Record<string, Element> = {};
  for (const [k, v] of Object.entries(model.elements)) {
    elements[k] = stripElementLocation(v);
  }
  const boundaries: Record<string, Boundary> = {};
  for (const [k, v] of Object.entries(model.boundaries)) {
    boundaries[k] = stripBoundaryLocation(v);
  }
  return {
    elements,
    boundaries,
    rootBoundaryNames: model.rootBoundaryNames,
    ...(model.workspace ? { workspace: model.workspace } : {}),
  };
};

const computePatch = (baseline: Model, current: Model): JsonPatchOp[] => {
  // Simple recursive diff producing RFC 6902 ops. Not optimal
  // (doesn't use LCS for arrays) but correct and small. For
  // sophisticated patch consumers, agents can use a dedicated
  // JSON Patch library on the model-json snapshot.
  const ops: JsonPatchOp[] = [];
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (Object.is(a, b)) return;
    if (
      typeof a !== "object" ||
      typeof b !== "object" ||
      a === null ||
      b === null ||
      Array.isArray(a) !== Array.isArray(b)
    ) {
      ops.push({ op: "replace", path, value: b });
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (JSON.stringify(a) === JSON.stringify(b)) return;
      ops.push({ op: "replace", path, value: b });
      return;
    }
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
    for (const k of keys) {
      const subPath = `${path}/${k.replaceAll("~", "~0").replaceAll("/", "~1")}`;
      if (!(k in bObj)) ops.push({ op: "remove", path: subPath });
      else if (k in aObj) {
        walk(aObj[k], bObj[k], subPath);
      } else {
        ops.push({ op: "add", path: subPath, value: bObj[k] });
      }
    }
  };
  walk(stripSourceLocation(baseline), stripSourceLocation(current), "");
  return ops;
};

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

/**
 * Compute the structural diff between two C4 Models. Pure function —
 * no I/O, no globals; safe to call from any layer that has access
 * to model objects (CLI command, library API, test fixtures).
 *
 * Sources passed in describe *what* baseline and current are
 * (file path, git ref, stdin label) — not loaded — and end up in
 * the envelope so downstream consumers can render headers without
 * tracking provenance separately.
 */
export const computeDiff = (
  baseline: Model,
  current: Model,
  baselineSide: DiffSide,
  currentSide: DiffSide,
  options: DiffOptions = {},
): DiffData => {
  const { changes: elementChanges, renameMap } = diffElements(
    baseline,
    current,
    options,
  );
  const boundaryChanges = diffBoundaries(baseline, current, options);
  const relationChanges = diffRelations(baseline, current, renameMap);
  const workspaceChanges = diffWorkspace(baseline.workspace, current.workspace);

  const allChanges: Change[] = [
    ...elementChanges,
    ...boundaryChanges,
    ...relationChanges,
    ...workspaceChanges,
  ].sort(compareChanges);

  const summary = buildSummary(allChanges);
  const groups = detectChangeGroups(allChanges, baseline, current);
  return {
    summary,
    changes: allChanges,
    ...(groups.length > 0 ? { groups } : {}),
    ...(options.withPatch ? { patch: computePatch(baseline, current) } : {}),
    baseline: baselineSide,
    current: currentSide,
  };
};
