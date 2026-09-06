/**
 * AST → Model mapping for the Structurizr DSL chevrotain parser.
 *
 * Maps every AST node the parser emits (workspace metadata + model
 * elements + body statements + relationships + directives) into the
 * canonical `Model` shape. Source positions captured by the lexer
 * propagate to `sourceLocation` on every Container / Boundary /
 * Relation that lands in the Model.
 *
 * Out of scope, tracked in grammar.md "Remaining gaps":
 *   - Archetype alias usage (`db myDb "Orders"` shorthand) and
 *     default propagation
 *   - Selector body propagation (`!element <ref> { tag "x" }`)
 */

import type {
  Boundary,
  Element,
  ElementKind,
  ModelIssue,
  Relation,
} from "../../../model";
import { buildModel } from "../../../model";
import { inferKindFromTechnology } from "../../_shared/kindHeuristics";
import type { LoadResult } from "../../types";
import { hasExternalTag } from "../types";
import type {
  ElementBodyNode,
  ElementNode,
  ModelChildNode,
  ModelNode,
  RelationshipBodyNode,
  RelationshipNode,
  ReopenNode,
  WorkspaceNode,
} from "./ast";

const STRUCTURIZR_LOADER = "structurizr";
type IdentifierScope = "flat" | "hierarchical";

interface IdentifierContext {
  readonly scope: IdentifierScope;
  readonly map: Map<string, string>;
}

/**
 * Convert a parsed Workspace AST into a `LoadResult`. Today the Model
 * contains the elements, body-statement data, and explicit relations
 * the parser recognises. `LoadResult.raw` (opaque blocks) and
 * ModelIssues (deployment family, hard-removed constructs) land in
 * later passes.
 */
export const toModel = (workspace: WorkspaceNode): LoadResult => {
  const containers: Element[] = [];
  const boundaries: Boundary[] = [];

  // Identifier index — declaration site → element name. We rely on this
  // to resolve relationship endpoints against assigned identifiers
  // (`api = container "..."` → `api` resolves to the container's name
  // = "API"). When no `assignedIdentifier` exists, the element's
  // user-visible `name` doubles as the lookup key.
  const identifiers: IdentifierContext = {
    scope: identifierScope(workspace),
    map: new Map<string, string>(),
  };

  // Parser-emitted issues. Collisions on identifier registration land
  // here so the linter can surface them through `LoadResult.issues`
  // without disturbing the structural model.
  const parserIssues: ModelIssue[] = collectWorkspaceIssues(workspace);

  // Reference parser reads `structurizr.groupSeparator` from the
  // model's `properties { ... }` block before walking the body —
  // nested groups need it to compose dotted names (`Outer/Inner`).
  // Without a separator, the reference simply concatenates names
  // (effectively no join); we mirror that by leaving the separator
  // undefined and falling back to the innermost name.
  const groupSeparator = readGroupSeparator(workspace);

  for (const model of pickModels(workspace)) {
    for (const child of model.children) {
      collectModelChild(
        child,
        containers,
        boundaries,
        identifiers,
        undefined,
        parserIssues,
        { groupSeparator, currentGroupPath: undefined },
      );
    }
  }

  if (impliedRelationshipsEnabled(workspace)) {
    applyImpliedRelationships(containers, boundaries);
  }

  const built = buildModel({
    elements: containers,
    boundaries,
    rootBoundaryNames: findRootBoundaryNames(boundaries),
    workspace: workspaceMetadata(workspace),
  });
  return {
    model: built.model,
    issues: [...parserIssues, ...built.issues],
  };
};

const identifierScope = (workspace: WorkspaceNode): IdentifierScope => {
  let scope: IdentifierScope = "flat";
  for (const node of workspace.body) {
    if (node.kind === "identifiers") scope = node.scope;
    if (node.kind !== "model") continue;
    for (const child of node.children) {
      if (child.kind === "identifiers") scope = child.scope;
    }
  }
  return scope;
};

const collectWorkspaceIssues = (workspace: WorkspaceNode): ModelIssue[] => {
  const issues: ModelIssue[] = [];
  if (workspace.extendsTarget) {
    issues.push({
      kind: "loader-warning",
      source: STRUCTURIZR_LOADER,
      code: "extends-not-expanded",
      message: `workspace extends "${workspace.extendsTarget.value}" was recorded as metadata but not expanded; aact loaded only local definitions.`,
    });
  }
  for (const node of workspace.body) {
    if (node.kind === "include") {
      issues.push(includeNotExpandedIssue(node.target.value));
    }
    if (node.kind !== "model") continue;
    for (const child of node.children) {
      if (child.kind === "include") {
        issues.push(includeNotExpandedIssue(child.target.value));
      }
    }
  }
  return issues;
};

const includeNotExpandedIssue = (target: string): ModelIssue => ({
  kind: "loader-warning",
  source: STRUCTURIZR_LOADER,
  code: "include-not-expanded",
  message: `!include "${target}" was parsed but not expanded; definitions from the included source are absent from the aact Model.`,
});

const findRootBoundaryNames = (boundaries: readonly Boundary[]): string[] => {
  const nested = new Set<string>();
  for (const boundary of boundaries) {
    for (const child of boundary.boundaryNames) {
      nested.add(child);
    }
  }
  return boundaries.map((b) => b.name).filter((name) => !nested.has(name));
};

/**
 * Surface workspace-level metadata from the AST so the Model carries
 * `Workspace.getName()` / `getDescription()` info the reference
 * parser exposes. Header positionals (`workspace "Name" "Desc"`)
 * are the base values; workspace-body `name "..."` / `description
 * "..."` overrides win (last-wins) per
 * `WorkspaceParser.parseName` / `parseDescription`. Returns undefined
 * when nothing useful was set so the Model object stays terse.
 */
const workspaceMetadata = (
  workspace: WorkspaceNode,
):
  | { name?: string; description?: string; extendsTarget?: string }
  | undefined => {
  const meta: { name?: string; description?: string; extendsTarget?: string } =
    {};
  if (workspace.name) meta.name = workspace.name.value;
  if (workspace.description) meta.description = workspace.description.value;
  for (const node of workspace.body) {
    if (node.kind === "nameOverride") meta.name = node.value.value;
    else if (node.kind === "descriptionOverride")
      meta.description = node.value.value;
  }
  if (workspace.extendsTarget)
    meta.extendsTarget = workspace.extendsTarget.value;
  if (Object.keys(meta).length === 0) return undefined;
  return meta;
};

/**
 * Walk every model block looking for a `structurizr.groupSeparator`
 * property entry. Reference parser exposes this as the join string
 * for nested group names (`group "Outer" { group "Inner" { ... } }`
 * becomes `properties.group = "Outer/Inner"` when separator is `/`).
 */
const readGroupSeparator = (workspace: WorkspaceNode): string | undefined => {
  for (const model of pickModels(workspace)) {
    for (const child of model.children) {
      if (child.kind !== "properties") continue;
      for (const entry of child.entries) {
        if (entry.key.value === "structurizr.groupSeparator") {
          return entry.value.value;
        }
      }
    }
  }
  return undefined;
};

/**
 * Context that travels alongside collectModelChild / handleElement /
 * handleGroup: configuration that affects how children are tagged
 * (currently just the group-separator + the in-flight nested group
 * name). Threaded by value so deep nesting doesn't accidentally
 * mutate a shared parent.
 */
interface GroupContext {
  readonly groupSeparator: string | undefined;
  readonly currentGroupPath: string | undefined;
}

/**
 * Walk every model block and look for an `!impliedRelationships true`
 * directive. The reference parser supports several strategy strings,
 * but the linter only needs the simple boolean `true` case today —
 * the default strategy is no-op and FQCN strategies are out of scope.
 */
const impliedRelationshipsEnabled = (workspace: WorkspaceNode): boolean => {
  for (const model of pickModels(workspace)) {
    for (const child of model.children) {
      if (
        child.kind === "impliedRelationships" &&
        child.value.value === "true"
      ) {
        return true;
      }
    }
  }
  return false;
};

/**
 * Apply the reference parser's
 * `CreateImpliedRelationshipsUnlessAnyRelationshipExistsStrategy`:
 *
 *   for every existing relation (source → destination):
 *     for every ancestor of source S' (S' != source, walking up boundaries):
 *       for every ancestor of destination D' (D' != destination):
 *         add an implied relation S' → D' inheriting the original
 *         description and technology, with empty tags — unless an
 *         identical relation already exists between S' and D'.
 *
 * Boundaries can have child containers (`Boundary.elementNames`)
 * and child boundaries (`Boundary.boundaryNames`); the parent chain
 * is reversed by scanning every boundary once.
 */
const applyImpliedRelationships = (
  containers: Element[],
  boundaries: Boundary[],
): void => {
  // Build a child-name → parent-name index for both containers and
  // boundaries. Boundaries are also Model elements in the reference;
  // we treat them as containers for the purpose of edge attachment
  // and add the implied edge by inserting a synthesized leaf if the
  // ancestor itself isn't a Container today.
  const parentOf = new Map<string, string>();
  for (const b of boundaries) {
    for (const c of b.elementNames) parentOf.set(c, b.name);
    for (const nested of b.boundaryNames) parentOf.set(nested, b.name);
  }

  const ancestorsOf = (name: string): readonly string[] => {
    const out: string[] = [];
    let cur = parentOf.get(name);
    while (cur) {
      out.push(cur);
      cur = parentOf.get(cur);
    }
    return out;
  };

  const relationExists = (
    fromName: string,
    toName: string,
    description: string | undefined,
  ): boolean => {
    const c = containers.find((x) => x.name === fromName);
    if (!c) return false;
    return c.relations.some(
      (r) => r.to === toName && r.description === description,
    );
  };

  // Snapshot the existing explicit relations BEFORE we start mutating,
  // so implied edges don't trigger further implied edges.
  type SourceRel = {
    sourceName: string;
    rel: Relation;
  };
  const seeds: SourceRel[] = [];
  for (const c of containers) {
    for (const rel of c.relations) {
      seeds.push({ sourceName: c.name, rel });
    }
  }

  for (const { sourceName, rel } of seeds) {
    const srcAncestors = ancestorsOf(sourceName);
    const dstAncestors = ancestorsOf(rel.to);
    // Pairs include (ancestor, dest), (source, ancestor), and
    // (ancestor, ancestor), excluding the original (source, dest).
    const pairs: { from: string; to: string }[] = [];
    for (const sa of srcAncestors) pairs.push({ from: sa, to: rel.to });
    for (const da of dstAncestors) pairs.push({ from: sourceName, to: da });
    for (const sa of srcAncestors) {
      for (const da of dstAncestors) {
        pairs.push({ from: sa, to: da });
      }
    }
    for (const { from, to } of pairs) {
      if (from === to) continue;
      if (relationExists(from, to, rel.description)) continue;
      const idx = containers.findIndex((x) => x.name === from);
      if (idx === -1) continue;
      const impliedRel: Relation = {
        to,
        description: rel.description,
        technology: rel.technology,
        tags: [], // implied relations have empty tags per reference
        sourceLocation: rel.sourceLocation,
      };
      containers[idx] = {
        ...containers[idx],
        relations: [...containers[idx].relations, impliedRel],
      };
    }
  }
};

/** Workspaces have at most one model block, but the AST permits MANY
 * for forward-compatibility. */
const pickModels = (workspace: WorkspaceNode): readonly ModelNode[] =>
  workspace.body.filter((b): b is ModelNode => b.kind === "model");

/**
 * Visit a model body child. Elements become Containers or Boundaries;
 * relationships go onto the source Container's `relations[]`. Nested
 * elements recurse with the parent's name pushed into the relationship
 * `resolutionScope`.
 */
const ELEMENT_KINDS = new Set([
  "person",
  "softwareSystem",
  "container",
  "component",
  "group",
  "element",
]);

type BodyStatementNode = Exclude<
  ElementBodyNode,
  ElementNode | RelationshipNode
>;

type AggregateBodyStatementNode =
  | BodyStatementNode
  | Extract<ElementNode, { kind: "group" }>;

const isGroupPropertyStatement = (
  node: ElementBodyNode,
): node is Extract<ElementNode, { kind: "group" }> =>
  node.kind === "group" && node.members.length === 0;

const isStructuralElementNode = (node: ElementBodyNode): node is ElementNode =>
  ELEMENT_KINDS.has(node.kind) && !isGroupPropertyStatement(node);

const collectModelChild = (
  child: ModelChildNode,
  containers: Element[],
  boundaries: Boundary[],
  identifiers: IdentifierContext,
  parentIdentifierPath: string | undefined,
  parserIssues: ModelIssue[],
  groupCtx: GroupContext,
): void => {
  if (child.kind === "relationship") {
    handleRelationship(child, containers, identifiers, parserIssues);
    return;
  }
  if (child.kind === "reopen") {
    handleReopen(
      child,
      containers,
      boundaries,
      identifiers,
      parserIssues,
      groupCtx,
    );
    return;
  }
  if (ELEMENT_KINDS.has(child.kind)) {
    handleElement(
      child as ElementNode,
      containers,
      boundaries,
      identifiers,
      parentIdentifierPath,
      parserIssues,
      groupCtx,
    );
  }
  // Directives (include / const / var / identifiers /
  // impliedRelationships) and `infoIssueBlock` diagnostics are present
  // in the AST today but don't yet feed into the Model — they'll land
  // alongside `LoadResult.raw` and ModelIssue wiring.
};

/**
 * Convert an element AST node into either a Container or a Boundary
 * (softwareSystem → System_Boundary; container with nested components →
 * Container_Boundary; otherwise → Container).
 *
 * Simplification: every leaf element becomes a Container with the
 * appropriate `kind`. softwareSystem at model scope becomes a Boundary
 * if it has nested containers; otherwise a System Container.
 */
/**
 * `GroupNode` has `members` instead of `body` — handle separately.
 * Non-empty group blocks are visual wrappers whose members are inlined
 * at the current scope. Empty group statements inside an element body
 * are grouping properties and are consumed by aggregateBody.
 */
const elementChildren = (
  element: ElementNode,
): readonly (ElementNode | RelationshipNode)[] => {
  if (element.kind === "group") return element.members;
  const out: (ElementNode | RelationshipNode)[] = [];
  for (const item of element.body) {
    if (item.kind === "relationship" || isStructuralElementNode(item)) {
      out.push(item);
    }
  }
  return out;
};

const handleGroup = (
  group: Extract<ElementNode, { kind: "group" }>,
  containers: Element[],
  boundaries: Boundary[],
  identifiers: IdentifierContext,
  parentIdentifierPath: string | undefined,
  parserIssues: ModelIssue[],
  groupCtx: GroupContext,
): void => {
  // Compose the group path. With a `structurizr.groupSeparator`
  // property, nested groups join their names — `group "Outer" {
  // group "Inner" { … } }` tags inner elements as
  // `Outer<sep>Inner`. Without the separator the reference parser
  // does not join (it would error in deployment contexts but is
  // lenient here); we mirror by falling back to the innermost name.
  const composedGroupName =
    groupCtx.currentGroupPath && groupCtx.groupSeparator
      ? `${groupCtx.currentGroupPath}${groupCtx.groupSeparator}${group.name.value}`
      : group.name.value;
  const nestedCtx: GroupContext = {
    ...groupCtx,
    currentGroupPath: composedGroupName,
  };

  const containersBefore = containers.length;
  const boundariesBefore = boundaries.length;
  for (const member of group.members) {
    if (member.kind === "relationship") {
      handleRelationship(
        member,
        containers,
        identifiers,
        parserIssues,
        undefined,
        parentIdentifierPath,
      );
    } else {
      handleElement(
        member,
        containers,
        boundaries,
        identifiers,
        parentIdentifierPath,
        parserIssues,
        nestedCtx,
      );
    }
  }
  // Tag every newly-added element with the composed group name —
  // but only if it doesn't already carry a `properties.group`. A
  // nested group will have stamped its own (deeper / longer) name
  // first; the outer group's pass must not overwrite it. The check
  // makes outer's tagging behave like a "fill-in-the-blanks" for
  // elements declared directly in the outer scope.
  for (let i = containersBefore; i < containers.length; i++) {
    if (containers[i].properties?.group !== undefined) continue;
    containers[i] = withGroupProperty(containers[i], composedGroupName);
  }
  for (let i = boundariesBefore; i < boundaries.length; i++) {
    if (boundaries[i].properties?.group !== undefined) continue;
    boundaries[i] = withGroupProperty(boundaries[i], composedGroupName);
  }
};

const withGroupProperty = <T extends Element | Boundary>(
  el: T,
  groupName: string,
): T => ({
  ...el,
  properties: { ...el.properties, group: groupName },
});

/**
 * Walk an `ElementNode` (or anything in a children list) and return
 * the concrete element / boundary nodes that should appear on the
 * enclosing boundary's `elementNames` / `boundaryNames`. For a group
 * this means flattening nested members; for an actual element it
 * yields the node itself. Relationships are filtered upstream and
 * never reach this helper.
 */
const flattenGroupTargets = (
  node: ElementNode | RelationshipNode,
): readonly Extract<ElementNode, { name: { value: string } }>[] => {
  if (node.kind === "relationship") return [];
  if (node.kind !== "group") {
    return [node];
  }
  const out: ReturnType<typeof flattenGroupTargets>[number][] = [];
  for (const member of node.members) {
    out.push(...flattenGroupTargets(member));
  }
  return out;
};

const handleBoundary = (
  element: Extract<ElementNode, { kind: "softwareSystem" | "container" }>,
  children: readonly (ElementNode | RelationshipNode)[],
  containers: Element[],
  boundaries: Boundary[],
  identifiers: IdentifierContext,
  selfIdentifierPath: string,
  name: string,
  parserIssues: ModelIssue[],
  groupCtx: GroupContext,
): void => {
  const displayName = element.name.value;
  const childContainerNames: string[] = [];
  const childBoundaryNames: string[] = [];
  for (const child of children) {
    if (child.kind === "relationship") continue;
    collectModelChild(
      child,
      containers,
      boundaries,
      identifiers,
      selfIdentifierPath,
      parserIssues,
      groupCtx,
    );
    // `group "Name" { … }` is a logical grouping, not a Model entity —
    // its members already landed in `containers` / `boundaries` via
    // `collectModelChild` above. Pushing the group's display name
    // onto `elementNames` would create a dangling reference that
    // `validateModel` correctly flags as `elementInBoundaryNotInModel`.
    // Flatten group members recursively instead so the boundary's
    // `elementNames` / `boundaryNames` describe what's actually in
    // the Model.
    for (const real of flattenGroupTargets(child)) {
      const childLookup = real.assignedIdentifier?.name ?? real.name.value;
      const childIdentifierPath = `${selfIdentifierPath}.${childLookup}`;
      const nestedName =
        identifiers.map.get(childIdentifierPath.toLowerCase()) ??
        identifiers.map.get(childLookup.toLowerCase()) ??
        childLookup;
      if (boundaries.some((b) => b.name === nestedName)) {
        childBoundaryNames.push(nestedName);
      } else {
        childContainerNames.push(nestedName);
      }
    }
  }
  for (const child of children) {
    if (child.kind === "relationship") {
      handleRelationship(
        child,
        containers,
        identifiers,
        parserIssues,
        name,
        selfIdentifierPath,
      );
    }
  }
  // Aggregate the parent element's own body statements onto the
  // Boundary. The reference parser treats softwareSystem/container
  // promoted to a boundary as the same element with the same
  // description/tags/url/properties — body statements should not
  // disappear just because the element gained nested children.
  const agg = aggregateBody(element);
  boundaries.push({
    name,
    label: displayName,
    kind: element.kind === "softwareSystem" ? "System" : "Container",
    description: agg.description,
    tags: agg.tags,
    elementNames: childContainerNames,
    boundaryNames: childBoundaryNames,
    link: agg.link,
    properties: agg.properties,
    sourceLocation: element.range,
  });
};

/**
 * Aggregate body statements (description / technology / tags / tag /
 * url / properties / perspectives) into Container field values. Body
 * statements OVERRIDE header positional values per the reference parser
 * (each `description "X"` call replaces the previous value).
 */
const aggregateBody = (
  element: Exclude<ElementNode, { kind: "group" }>,
): {
  description: string | undefined;
  technology: string | undefined;
  tags: string[];
  link: string | undefined;
  properties: Record<string, string> | undefined;
} => {
  let description: string | undefined =
    element.kind === "person" ||
    element.kind === "softwareSystem" ||
    element.kind === "container" ||
    element.kind === "component" ||
    element.kind === "element"
      ? element.headerDescription?.value
      : undefined;
  let technology: string | undefined =
    element.kind === "container" || element.kind === "component"
      ? element.headerTechnology?.value
      : undefined;
  // Only user-authored tags land in the Model. The reference parser
  // stamps implicit styling tags ("Element" plus a kind tag) on every
  // element, but those duplicate the typed `kind` field and no rule
  // reads them — keeping them out makes `Model.tags` uniform with the
  // PlantUML / kubernetes / compose loaders. The generator re-derives
  // the DSL keyword from `kind`, so round-trips stay faithful.
  const tags: string[] = [];
  if (element.headerTags?.value)
    tags.push(...splitTags(element.headerTags.value));
  let link: string | undefined;
  let properties: Record<string, string> | undefined;

  for (const item of element.body) {
    switch (item.kind) {
      case "description": {
        description = item.value.value;
        break;
      }
      case "technology": {
        technology = item.value.value;
        break;
      }
      case "tags": {
        tags.push(...splitTags(item.value.value));
        break;
      }
      case "tag": {
        // `tag` is an alias for `tags` in the reference; same split.
        tags.push(...splitTags(item.value.value));
        break;
      }
      case "url": {
        link = item.value.value;
        break;
      }
      case "properties": {
        properties = properties ?? {};
        for (const entry of item.entries) {
          properties[entry.key.value] = entry.value.value;
        }

        break;
      }
      case "perspectives": {
        properties = properties ?? {};
        for (const entry of item.entries) {
          const key = `perspective.${entry.name.name}`;
          properties[key] = entry.description.value;
          // Reference always exposes `Perspective.getValue()` as a
          // string — `""` when the user omitted the third argument.
          // Mirror that with an explicit empty-string property so
          // downstream lookups don't see undefined.
          properties[`${key}.value`] = entry.value?.value ?? "";
        }

        break;
      }
      case "group": {
        // `<element> { group "<name>" }` (no `{ }` block on the
        // group) — reference parser treats this as a property
        // assignment: `Component.properties.group = "<name>"`
        // (StructurizrDslParser.java:690-691). The visitor surfaces
        // the group statement as a GroupNode in the body; when its
        // `members` array is empty, it's the property-statement form.
        if (item.members.length === 0) {
          properties = properties ?? {};
          properties.group = item.name.value;
        }
        break;
      }
      // No default
    }
  }
  // De-dupe tags while preserving order.
  const seen = new Set<string>();
  const dedupedTags = tags.filter((t) =>
    seen.has(t) ? false : (seen.add(t), true),
  );
  return { description, technology, tags: dedupedTags, link, properties };
};

const handleLeaf = (
  element: Exclude<ElementNode, { kind: "group" }>,
  children: readonly (ElementNode | RelationshipNode)[],
  containers: Element[],
  identifiers: IdentifierContext,
  name: string,
  parentIdentifierPath: string | undefined,
  parserIssues: ModelIssue[],
): void => {
  const displayName = element.name.value;
  const agg = aggregateBody(element);
  const kind = kindFromLeaf(element, agg.technology);
  const external =
    element.kind === "softwareSystem" && hasExternalTag(agg.tags);
  containers.push({
    name,
    label: displayName,
    kind,
    external,
    description: agg.description ?? "",
    tags: agg.tags,
    technology: agg.technology,
    relations: [],
    link: agg.link,
    properties: agg.properties,
    sourceLocation: element.range,
  });
  for (const child of children) {
    if (child.kind === "relationship") {
      handleRelationship(
        child,
        containers,
        identifiers,
        parserIssues,
        name,
        parentIdentifierPath,
      );
    }
  }
};

const handleElement = (
  element: ElementNode,
  containers: Element[],
  boundaries: Boundary[],
  identifiers: IdentifierContext,
  parentIdentifierPath: string | undefined,
  parserIssues: ModelIssue[],
  groupCtx: GroupContext,
): void => {
  if (element.kind === "group") {
    handleGroup(
      element,
      containers,
      boundaries,
      identifiers,
      parentIdentifierPath,
      parserIssues,
      groupCtx,
    );
    return;
  }

  const displayName = element.name.value;
  // Container.name is the DSL identifier (the short id authors write
  // in source — `orders_crud = container "Orders CRUD"` gives name
  // `orders_crud` and label `Orders CRUD`). Matches the Model JSDoc
  // contract: "PlantUML alias / Structurizr structurizr.dsl.identifier".
  // When the user omits the `id =` prefix, the display name doubles
  // as the identifier.
  const lookupKey = element.assignedIdentifier?.name ?? displayName;
  const selfIdentifierPath = parentIdentifierPath
    ? `${parentIdentifierPath}.${lookupKey}`
    : lookupKey;
  const modelName =
    identifiers.scope === "hierarchical" ? selfIdentifierPath : lookupKey;
  // Reference parser's `IdentifiersRegister.register` throws when the
  // same identifier is bound to two distinct elements. We detect this
  // separately from the resolution map (which holds id→id) by
  // checking whether a Container/Boundary with this name already
  // exists. Surface the collision as a ModelIssue so the linter
  // warns without aborting the parse — last-write-wins keeps the
  // most recent element as the resolution target.
  // Case-insensitive: `IdentifiersRegister.getElement` does
  // equalsIgnoreCase, so `BANK` colliding with `bank` registers as a
  // duplicate too. Checking identifierMap.has on the lowercased key
  // catches that — identifierMap is populated only by handleElement,
  // not by reopen, so reopens don't trigger false positives.
  const registrationKey =
    identifiers.scope === "hierarchical" ? selfIdentifierPath : lookupKey;
  const alreadyRegistered = identifiers.map.has(registrationKey.toLowerCase());
  if (alreadyRegistered) {
    parserIssues.push({
      kind: "duplicate-identifier",
      identifier: registrationKey,
    });
  }
  // Keys are stored lowercased and looked up lowercased to mirror the
  // reference parser's equalsIgnoreCase identifier resolution. The
  // mapped value is the canonical identifier itself (the
  // Model.elements key) — relations / reopens resolve to that.
  identifiers.map.set(registrationKey.toLowerCase(), modelName);
  if (identifiers.scope === "hierarchical" && !parentIdentifierPath) {
    identifiers.map.set(lookupKey.toLowerCase(), modelName);
  }

  const children = elementChildren(element);
  const nestedElements = children.filter(
    (c): c is ElementNode => c.kind !== "relationship",
  );
  const isBoundary =
    (element.kind === "softwareSystem" || element.kind === "container") &&
    nestedElements.length > 0;

  if (isBoundary) {
    handleBoundary(
      element,
      children,
      containers,
      boundaries,
      identifiers,
      selfIdentifierPath,
      modelName,
      parserIssues,
      groupCtx,
    );
    return;
  }
  handleLeaf(
    element,
    children,
    containers,
    identifiers,
    modelName,
    parentIdentifierPath,
    parserIssues,
  );
};

const kindFromLeaf = (
  element: Exclude<ElementNode, { kind: "group" }>,
  technology: string | undefined,
): ElementKind => {
  if (element.kind === "container") {
    return inferKindFromTechnology(technology, element.name.value);
  }
  return kindFromAstKind(element.kind);
};

const kindFromAstKind = (k: ElementNode["kind"]): ElementKind => {
  switch (k) {
    case "person": {
      return "Person";
    }
    case "softwareSystem": {
      return "System";
    }
    case "container": {
      return "Container";
    }
    case "component": {
      return "Component";
    }
    case "group": {
      // Groups have no Container counterpart and are handled before
      // leaf kind mapping. This fallback keeps the switch exhaustive.
      return "Container";
    }
    case "element": {
      // CustomElement is the escape hatch outside the five C4 kinds —
      // `Element` is an abstract C4 concept, not a kind. Surface it
      // as `Container` so the Model contract stays closed, then tags
      // (`["Element"]`) signal the special case to rules.
      return "Container";
    }
  }
};

/**
 * Push a Relation onto the source Container's `relations[]`. Source/dest
 * identifiers are resolved through `identifiers`. When the relationship
 * is in implicit-source form (`-> destination`) the source comes from
 * `enclosingElementName` — the element whose body contains the line.
 *
 * The `-/>` no-relationship form is parsed for grammar completeness
 * (deployment views use it) but does not produce a Model edge today.
 */
const handleRelationship = (
  rel: RelationshipNode,
  containers: Element[],
  identifiers: IdentifierContext,
  parserIssues: ModelIssue[],
  enclosingElementName?: string,
  referenceContextPath?: string,
): void => {
  if (rel.arrow === "-/>") return; // no-relationship form — deployment-only
  const sourceName = resolveRelationshipSource(
    rel,
    identifiers,
    enclosingElementName,
    referenceContextPath,
  );
  // `this` keyword on the destination side resolves to the enclosing
  // element — same rule as on the source side. `softwareSystem "X" {
  // container "Y" { other -> this } }` makes `Y` the destination.
  const destinationName = rel.destination.isThis
    ? enclosingElementName
    : resolveIdentifierRef(rel.destination, identifiers, referenceContextPath);
  if (!sourceName) {
    parserIssues.push({
      kind: "loader-warning",
      source: "structurizr",
      code: "relationship-source-not-resolved",
      message: `Relationship to "${rel.destination.name}" has no resolvable source in this scope and was ignored.`,
      element: rel.destination.name,
    });
    return;
  }
  if (!destinationName) {
    parserIssues.push({
      kind: "loader-warning",
      source: "structurizr",
      code: "relationship-destination-not-resolved",
      message: `Relationship from "${sourceName}" references unknown destination "${rel.destination.name}" and was ignored.`,
      element: sourceName,
    });
    return;
  }

  const sourceContainer = containers.find((c) => c.name === sourceName);
  if (!sourceContainer) {
    parserIssues.push({
      kind: "loader-warning",
      source: "structurizr",
      code: "relationship-source-not-represented",
      message: `Relationship source "${sourceName}" maps to a Boundary or unsupported element in aact; relation was ignored.`,
      element: sourceName,
    });
    return;
  }

  const body = aggregateRelationshipBody(rel.body);
  const relation: Relation = {
    to: destinationName,
    description: rel.headerDescription?.value,
    technology: rel.headerTechnology?.value,
    tags: dedupeTags([
      ...(rel.headerTags ? splitTags(rel.headerTags.value) : []),
      ...body.tags,
    ]),
    link: body.link,
    properties: body.properties,
    sourceLocation: rel.range,
  };

  // Container.relations is readonly in the public Model type, but the
  // collection arrays inside this builder are mutable. Replace the
  // entry in the containers list with a fresh object whose relations
  // include the new one. buildModel takes the final list once.
  const idx = containers.indexOf(sourceContainer);
  containers[idx] = {
    ...sourceContainer,
    relations: [...sourceContainer.relations, relation],
  };
};

const aggregateRelationshipBody = (
  statements: readonly RelationshipBodyNode[],
): {
  tags: string[];
  link: string | undefined;
  properties: Record<string, string> | undefined;
} => {
  const tags: string[] = [];
  let link: string | undefined;
  let properties: Record<string, string> | undefined;

  for (const item of statements) {
    switch (item.kind) {
      case "tags":
      case "tag": {
        tags.push(...splitTags(item.value.value));
        break;
      }
      case "url": {
        link = item.value.value;
        break;
      }
      case "properties": {
        properties = properties ?? {};
        for (const entry of item.entries) {
          properties[entry.key.value] = entry.value.value;
        }
        break;
      }
      case "perspectives": {
        properties = properties ?? {};
        for (const entry of item.entries) {
          const key = `perspective.${entry.name.name}`;
          properties[key] = entry.description.value;
          properties[`${key}.value`] = entry.value?.value ?? "";
        }
        break;
      }
    }
  }

  return { tags: dedupeTags(tags), link, properties };
};

/**
 * Re-open form: `existing { body }`. Find the previously declared
 * element by identifier (possibly hierarchical: `bank.api`) and merge
 * its body statements into the existing Container or Boundary.
 * Relationships inside the reopen body get the resolved target as
 * their implicit source.
 */
const handleReopen = (
  reopen: ReopenNode,
  containers: Element[],
  boundaries: Boundary[],
  identifiers: IdentifierContext,
  parserIssues: ModelIssue[],
  groupCtx: GroupContext,
): void => {
  const targetDisplay =
    resolveIdentifierRef(reopen.target, identifiers) ?? reopen.target.name;

  const bodyStatements = reopen.body.filter(
    (b): b is AggregateBodyStatementNode =>
      b.kind !== "relationship" &&
      (!ELEMENT_KINDS.has(b.kind) || isGroupPropertyStatement(b)),
  );
  const relationships = reopen.body.filter(
    (b): b is RelationshipNode => b.kind === "relationship",
  );
  // Reopen may also introduce NEW nested element declarations:
  //   `bank { db = container "DB" }` adds `db` under `bank`. Reference
  //   parser walks them through the regular element handler with the
  //   target as the parent identifier path; we mirror that.
  const newElements = reopen.body.filter((b): b is ElementNode =>
    isStructuralElementNode(b),
  );

  const containerIdx = containers.findIndex((c) => c.name === targetDisplay);
  if (containerIdx !== -1) {
    containers[containerIdx] = mergeContainerBody(
      containers[containerIdx],
      bodyStatements,
    );
    for (const rel of relationships) {
      handleRelationship(
        rel,
        containers,
        identifiers,
        parserIssues,
        targetDisplay,
        targetDisplay,
      );
    }
    // New child element on a leaf Container — process it as a
    // standalone element. Reference would promote the Container to a
    // Boundary; we land elements at model scope and let the user
    // re-declare as Boundary if they need promotion.
    for (const child of newElements) {
      handleElement(
        child,
        containers,
        boundaries,
        identifiers,
        targetDisplay,
        parserIssues,
        groupCtx,
      );
    }
    return;
  }

  const boundaryIdx = boundaries.findIndex((b) => b.name === targetDisplay);
  if (boundaryIdx !== -1) {
    boundaries[boundaryIdx] = mergeBoundaryBody(
      boundaries[boundaryIdx],
      bodyStatements,
    );
    for (const rel of relationships) {
      handleRelationship(
        rel,
        containers,
        identifiers,
        parserIssues,
        targetDisplay,
        targetDisplay,
      );
    }
    // New nested elements: process them, then patch the target
    // Boundary's elementNames / boundaryNames lists to include
    // the newcomers so the structural Model stays consistent.
    const containersBefore = containers.length;
    const boundariesBefore = boundaries.length;
    for (const child of newElements) {
      handleElement(
        child,
        containers,
        boundaries,
        identifiers,
        targetDisplay,
        parserIssues,
        groupCtx,
      );
    }
    if (
      containers.length > containersBefore ||
      boundaries.length > boundariesBefore
    ) {
      const addedContainerNames = containers
        .slice(containersBefore)
        .map((c) => c.name);
      const addedBoundaryNames = boundaries
        .slice(boundariesBefore)
        .map((b) => b.name);
      const target = boundaries[boundaryIdx];
      boundaries[boundaryIdx] = {
        ...target,
        elementNames: [...target.elementNames, ...addedContainerNames],
        boundaryNames: [...target.boundaryNames, ...addedBoundaryNames],
      };
    }
    return;
  }
  parserIssues.push({
    kind: "loader-warning",
    source: "structurizr",
    code: "reopen-target-not-found",
    message: `Reopen target "${reopen.target.name}" was not found; body was ignored.`,
    element: reopen.target.name,
  });
};

/**
 * Apply body-statement deltas (description / technology / tags / url /
 * properties) to an existing Container. Used by the reopen path.
 */
const mergeContainerBody = (
  c: Element,
  statements: readonly AggregateBodyStatementNode[],
): Element => {
  const delta = aggregateBodyStatements(statements);
  const technology = delta.technology ?? c.technology;
  const tags = dedupeTags([...c.tags, ...delta.tags]);
  return {
    ...c,
    description: delta.description ?? c.description,
    kind: inferKindForExistingContainer(c, technology),
    external: c.kind === "System" ? hasExternalTag(tags) : c.external,
    technology,
    tags,
    link: delta.link ?? c.link,
    properties: mergeProperties(c.properties, delta.properties),
  };
};

const inferKindForExistingContainer = (
  c: Element,
  technology: string | undefined,
): ElementKind => {
  if (
    c.kind === "Container" ||
    c.kind === "ContainerDb" ||
    c.kind === "ContainerQueue"
  ) {
    return inferKindFromTechnology(technology, c.label ?? c.name);
  }
  return c.kind;
};

const mergeBoundaryBody = (
  b: Boundary,
  statements: readonly AggregateBodyStatementNode[],
): Boundary => {
  const delta = aggregateBodyStatements(statements);
  return {
    ...b,
    description: delta.description ?? b.description,
    tags: dedupeTags([...b.tags, ...delta.tags]),
    link: delta.link ?? b.link,
    properties: mergeProperties(b.properties, delta.properties),
  };
};

const mergeProperties = (
  base: Readonly<Record<string, string>> | undefined,
  delta: Record<string, string> | undefined,
): Record<string, string> | undefined => {
  if (!base && !delta) return undefined;
  return { ...base, ...delta };
};

const dedupeTags = (tags: readonly string[]): string[] => {
  const seen = new Set<string>();
  return tags.filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
};

/**
 * Aggregate a list of body statements into a normalised delta.
 * Mirrors the relevant cases from aggregateBody but without an
 * element header to seed defaults from.
 */
const aggregateBodyStatements = (
  statements: readonly AggregateBodyStatementNode[],
): {
  description: string | undefined;
  technology: string | undefined;
  tags: string[];
  link: string | undefined;
  properties: Record<string, string> | undefined;
} => {
  let description: string | undefined;
  let technology: string | undefined;
  const tags: string[] = [];
  let link: string | undefined;
  let properties: Record<string, string> | undefined;

  for (const item of statements) {
    switch (item.kind) {
      case "description": {
        description = item.value.value;
        break;
      }
      case "technology": {
        technology = item.value.value;
        break;
      }
      case "tags": {
        tags.push(...splitTags(item.value.value));
        break;
      }
      case "tag": {
        // `tag` is an alias for `tags` in the reference; same split.
        tags.push(...splitTags(item.value.value));
        break;
      }
      case "url": {
        link = item.value.value;
        break;
      }
      case "properties": {
        properties = properties ?? {};
        for (const entry of item.entries) {
          properties[entry.key.value] = entry.value.value;
        }
        break;
      }
      case "perspectives": {
        properties = properties ?? {};
        for (const entry of item.entries) {
          const key = `perspective.${entry.name.name}`;
          properties[key] = entry.description.value;
          if (entry.value) {
            properties[`${key}.value`] = entry.value.value;
          }
        }
        break;
      }
      case "group": {
        if (item.members.length === 0) {
          properties = properties ?? {};
          properties.group = item.name.value;
        }
        break;
      }
      // No default
    }
  }
  return { description, technology, tags, link, properties };
};

/**
 * Resolve a relationship's source identifier to the target Container's
 * name. Three cases:
 *   - explicit source (`a -> b`) → look up `a` in the identifier map
 *   - `this -> b` → enclosing element
 *   - implicit source (`-> b`) → enclosing element
 */
const resolveRelationshipSource = (
  rel: RelationshipNode,
  identifiers: IdentifierContext,
  enclosingElementName: string | undefined,
  referenceContextPath: string | undefined,
): string | undefined => {
  if (!rel.source) return enclosingElementName;
  if (rel.source.isThis) return enclosingElementName;
  return resolveIdentifierRef(rel.source, identifiers, referenceContextPath);
};

const resolveIdentifierRef = (
  ref: { readonly name: string },
  identifiers: IdentifierContext,
  referenceContextPath?: string,
): string | undefined => {
  const raw = ref.name.toLowerCase();
  if (
    identifiers.scope === "hierarchical" &&
    referenceContextPath &&
    !ref.name.includes(".")
  ) {
    const scoped = identifiers.map.get(
      `${referenceContextPath}.${ref.name}`.toLowerCase(),
    );
    if (scoped) return scoped;
  }
  const direct = identifiers.map.get(raw);
  if (direct) return direct;
  return identifiers.scope === "flat" ? ref.name : undefined;
};

const splitTags = (raw: string): readonly string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// Re-export the Model type so callers don't need a separate import.

export { type Model } from "../../../model";
