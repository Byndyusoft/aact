import consola from "consola";

import type { Element, SourceLocation } from "../model";
import { allElements, getElement, isDatabaseElement, targetOf } from "../model";
import {
  buildElementBoundaryMap,
  resolveRedirectTarget,
} from "./lib/boundaryUtils";
import {
  DEFAULT_REPO_NAME_PATTERNS,
  matchesAnyName,
} from "./lib/namingPatterns";
import type {
  FixResult,
  RelatedLocation,
  RuleDefinition,
  SourceEdit,
  Violation,
} from "./types";

export interface DbPerServiceOptions {
  /** Tags маркирующие repo/relay контейнеры — определяют owner of DB. */
  readonly ownerTags?: readonly string[];
  /**
   * Picomatch globs (case-insensitive). Container counts as an owner
   * (repo/relay) even without an explicit tag if its name matches
   * any pattern. Mirrors `crud.repoNamePatterns` — same defaults,
   * same intent. Configure independently when DB-owner naming
   * conventions diverge from generic repo conventions.
   */
  readonly ownerNamePatterns?: readonly string[];
}

const DEFAULT_OWNER_TAGS: readonly string[] = ["repo", "relay"];

/** Owner identity: explicit tag OR name-convention match. */
const isOwner = (
  element: Element,
  options: DbPerServiceOptions | undefined,
): boolean => {
  const tags = options?.ownerTags ?? DEFAULT_OWNER_TAGS;
  if (tags.some((t) => element.tags.includes(t))) return true;
  return matchesAnyName(
    element.name,
    options?.ownerNamePatterns ?? DEFAULT_REPO_NAME_PATTERNS,
  );
};

const resolveOwner = (
  dbName: string,
  accessors: readonly Element[],
  options: DbPerServiceOptions | undefined,
): Element => {
  const tagged = accessors.filter((c) => isOwner(c, options));

  if (tagged.length === 0) {
    const tagNames = (options?.ownerTags ?? DEFAULT_OWNER_TAGS).join("/");
    consola.warn(
      `Cannot determine owner of ${dbName}: no ${tagNames} tagged accessor found, using ${accessors[0].name}`,
    );
    return accessors[0];
  }

  if (tagged.length > 1) {
    consola.warn(
      `Cannot determine owner of ${dbName}: multiple tagged accessors (${tagged.map((c) => c.name).join(", ")}), using ${tagged[0].name}`,
    );
  }

  return tagged[0];
};

/**
 * Database per Service: одна база — один владелец. Если несколько
 * контейнеров напрямую обращаются к одной БД, это нарушение принципа.
 */
export const dbPerServiceRule: RuleDefinition<DbPerServiceOptions> = {
  name: "dbPerService",
  description:
    "Each database container must have a single owner (one repo/relay per DB)",
  rationale:
    "When two or more services share a database, the schema becomes a multi-team coupling point: every column rename, index change, or migration needs coordination across teams that otherwise wouldn't talk. This is the canonical 'shared database antipattern' — it kills the independence promise of microservices. One repo/relay container owns the DB, exposes a typed API, and absorbs all schema churn behind it. Other services consume the API, not the rows.",
  examples: [
    {
      label: "bad",
      source: `Container(orders, "Orders")
Container(billing, "Billing")
ContainerDb(orders_db, "Orders DB")
Rel(orders, orders_db, "SQL")
Rel(billing, orders_db, "SQL")`,
      note: "`orders_db` has two direct accessors — schema couples both teams.",
    },
    {
      label: "good",
      source: `Container(orders_repo, "Orders Repo", $tags="repo")
Container(orders, "Orders")
Container(billing, "Billing")
ContainerDb(orders_db, "Orders DB")
Rel(orders, orders_repo, "fetches")
Rel(billing, orders_repo, "fetches")
Rel(orders_repo, orders_db, "SQL")`,
    },
  ],
  adrPath: "ADRs/Database per CRUD-service.md",

  check(model) {
    const violations: Violation[] = [];
    const primaryAnchor = (
      db: Element | undefined,
      edges: readonly { edgeLocation: SourceLocation | undefined }[],
    ): { sourceLocation?: SourceLocation } => {
      if (db?.sourceLocation) return { sourceLocation: db.sourceLocation };
      const fallback = edges[0]?.edgeLocation;
      return fallback ? { sourceLocation: fallback } : {};
    };
    // Track every accessor + its specific edge to the DB so we can
    // primary-anchor on the DB declaration (the conceptual location
    // of the problem: "this DB has too many owners") and list each
    // offending accessor edge as a related location.
    interface AccessorEdge {
      readonly name: string;
      readonly edgeLocation: SourceLocation | undefined;
    }
    const dbAccessMap = new Map<string, AccessorEdge[]>();

    for (const element of allElements(model)) {
      for (const rel of element.relations) {
        if (isDatabaseElement(targetOf(model, rel))) {
          const existing = dbAccessMap.get(rel.to);
          const edge = { name: element.name, edgeLocation: rel.sourceLocation };
          if (existing) existing.push(edge);
          else dbAccessMap.set(rel.to, [edge]);
        }
      }
    }

    for (const [dbName, accessorEdges] of dbAccessMap) {
      if (accessorEdges.length <= 1) continue;

      const dbElement = getElement(model, dbName);
      const related: RelatedLocation[] = [];
      for (const a of accessorEdges) {
        if (a.edgeLocation) {
          related.push({
            sourceLocation: a.edgeLocation,
            message: `accessor: ${a.name}`,
          });
        }
      }

      violations.push({
        target: dbName,
        targetKind: "element" as const,
        message: `shared between ${accessorEdges.map((a) => a.name).join(", ")} — each database should have a single owner`,
        // Primary anchor: the DB declaration itself — that's where the
        // "too many owners" property lives. Falls back to first
        // accessor edge if the loader didn't populate the element's
        // location (regex-based loaders may leave it undefined).
        ...primaryAnchor(dbElement, accessorEdges),
        ...(related.length > 0 ? { relatedLocations: related } : {}),
      });
    }

    return violations;
  },

  fix(ctx) {
    const { model, violations, syntax, options } = ctx;
    const ownerTags = options?.ownerTags ?? DEFAULT_OWNER_TAGS;
    const elementBoundaryMap = buildElementBoundaryMap(model);
    const results: FixResult[] = [];

    for (const violation of violations) {
      // Stryker disable all
      const db = allElements(model).find(
        (c) => c.name === violation.target && isDatabaseElement(c),
      );
      // Stryker restore all
      if (!db) continue;

      const accessors = allElements(model).filter((c) =>
        c.relations.some((r) => r.to === db.name),
      );
      // Stryker disable next-line all
      if (accessors.length <= 1) continue;

      const owner = resolveOwner(db.name, accessors, options);

      // Where the rewired edges actually go — owner or the owning context's API.
      const targets = new Set<string>();
      const edits: SourceEdit[] = accessors
        .filter((c) => c !== owner)
        .flatMap((accessor): SourceEdit[] => {
          // Stryker disable next-line all
          const rel = accessor.relations.find((r) => r.to === db.name)!;
          if (!rel.sourceLocation) return [];

          const redirectTarget = resolveRedirectTarget(
            accessor,
            db,
            owner,
            ownerTags,
            model,
            elementBoundaryMap,
            "dbPerService",
          );
          if (!redirectTarget) return [];
          targets.add(redirectTarget.name);

          const tags = rel.tags.length > 0 ? rel.tags.join("+") : undefined;
          return [
            {
              kind: "replace",
              range: rel.sourceLocation,
              // The DB protocol described the old edge; the new one calls the
              // owner (or the owning context's API), so it is dropped.
              content: syntax.relationDecl(accessor.name, redirectTarget.name, {
                description: rel.description,
                tags,
              }),
            },
          ];
        });

      if (edits.length === 0) continue;

      results.push({
        ruleId: "dbPerService",
        description: `Redirect access to ${db.name} through ${[...targets].join(", ")}`,
        edits,
      });
    }

    return results;
  },
};
