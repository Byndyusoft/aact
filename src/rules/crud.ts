import consola from "consola";

import type { FormatSyntax } from "../formats/types";
import type { Element, Model } from "../model";
import { allElements, getElement, isDatabaseElement, targetOf } from "../model";
import {
  buildElementBoundaryMap,
  resolveRedirectTarget,
} from "./lib/boundaryUtils";
import {
  DEFAULT_REPO_NAME_PATTERNS,
  matchesAnyName,
} from "./lib/namingPatterns";
import type { NamingConvention } from "./lib/namingUtils";
import { detectNamingConvention, joinName } from "./lib/namingUtils";
import type {
  FixResult,
  RelatedLocation,
  RuleDefinition,
  SourceEdit,
  Violation,
} from "./types";

export interface CrudOptions {
  /** Tags маркирующие repo/relay контейнеры. Default ["repo", "relay"]. */
  readonly repoTags?: readonly string[];
  /**
   * Picomatch globs (case-insensitive). Container counts as a repo
   * even without an explicit tag if its name matches any pattern.
   * Closes the legacy-archive use case where naming convention
   * (`*_repository`, `*Storage`) carries the intent that the project
   * never got around to expressing as explicit tags. Default covers
   * `*_repo`, `*_repository`, `*_storage`, `*_dao`, `*_store` and
   * PascalCase variants.
   */
  readonly repoNamePatterns?: readonly string[];
}

const DEFAULT_REPO_TAGS: readonly string[] = ["repo", "relay"];

/** Repo identity: explicit tag OR name-convention match. Used by both
 *  check (to decide whether direct-db access from `c` is allowed) and
 *  fix (to spot an existing repo by name when offering to rewire). */
const isRepo = (
  element: Element,
  options: CrudOptions | undefined,
): boolean => {
  const tags = options?.repoTags ?? DEFAULT_REPO_TAGS;
  if (tags.some((t) => element.tags.includes(t))) return true;
  return matchesAnyName(
    element.name,
    options?.repoNamePatterns ?? DEFAULT_REPO_NAME_PATTERNS,
  );
};

const stripDbWord = (name: string): string => {
  const lower = name.toLowerCase();
  for (const suffix of [
    "_database",
    "-database",
    "database",
    "_db",
    "-db",
    "db",
  ]) {
    if (lower.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  return name;
};

const deriveRepoName = (
  dbName: string,
  convention: NamingConvention,
): string => {
  const base = stripDbWord(dbName);
  return joinName(base || dbName, "repo", convention);
};

const deriveRepoLabel = (dbName: string): string => {
  const base = stripDbWord(dbName);
  const word = base || dbName;
  return (
    word.charAt(0).toUpperCase() + word.slice(1).replaceAll("_", " ") + " Repo"
  );
};

const fixNonRepoAccessesDb = (
  accessor: Element,
  model: Model,
  syntax: FormatSyntax,
  options: CrudOptions | undefined,
  convention: NamingConvention,
): FixResult | undefined => {
  const ownerTags = options?.repoTags ?? DEFAULT_REPO_TAGS;
  const dbRels = accessor.relations.filter((r) =>
    isDatabaseElement(targetOf(model, r)),
  );
  const elementBoundaryMap = buildElementBoundaryMap(model);
  // What each rewired DB edge now goes through — for the fix description,
  // which has to name the real target (a repo, or another context's API).
  const routes: string[] = [];

  const edits: SourceEdit[] = dbRels.flatMap((rel): SourceEdit[] => {
    const db = targetOf(model, rel);
    if (!db) return [];
    if (!rel.sourceLocation) return [];

    // Find any existing repo for `db` — including one identified by
    // name convention (e.g. `user_repository` in a legacy archive
    // without explicit `repo` tags). Per Safin's feedback: prefer
    // re-using an existing container over creating a new one.
    // Stryker disable next-line ConditionalExpression
    const existingRepo = allElements(model).find(
      (c) =>
        c !== accessor &&
        c.relations.some((r) => r.to === db.name) &&
        isRepo(c, options),
    );

    if (existingRepo) {
      const redirectTarget = resolveRedirectTarget(
        accessor,
        db,
        existingRepo,
        ownerTags,
        model,
        elementBoundaryMap,
        "crud",
      );
      if (!redirectTarget) return [];
      // If the existing repo was identified by name convention only
      // (no explicit tag), the rewire alone isn't enough — re-running
      // `check` would still flag the same accessor because
      // `existingRepo.tags` lacks the repo tag. Emit a redeclaration
      // of the repo with the canonical tag attached so the rule
      // converges in one --fix pass.
      const repoNeedsTagging = !ownerTags.some((t) =>
        existingRepo.tags.includes(t),
      );
      const canonicalRepoTag = ownerTags[0] ?? "repo";
      const tagEdits: SourceEdit[] =
        repoNeedsTagging && existingRepo.sourceLocation
          ? [
              {
                kind: "replace",
                range: existingRepo.sourceLocation,
                content: syntax.containerDecl({
                  ...existingRepo,
                  tags: [...existingRepo.tags, canonicalRepoTag],
                }),
              },
            ]
          : [];
      routes.push(`${db.name} via ${redirectTarget.name}`);
      return [
        ...tagEdits,
        {
          kind: "replace",
          range: rel.sourceLocation,
          // The DB protocol (SQL, PostgreSQL…) described the old edge; the
          // new one is a call to a repo or a service, so it is dropped.
          content: syntax.relationDecl(accessor.name, redirectTarget.name, {
            description: rel.description,
            tags: rel.tags.length > 0 ? rel.tags.join("+") : undefined,
          }),
        },
      ];
    }

    const accessorBoundary = elementBoundaryMap.get(accessor.name);
    const dbBoundary = elementBoundaryMap.get(db.name);
    if (
      accessorBoundary !== undefined &&
      dbBoundary !== undefined &&
      accessorBoundary !== dbBoundary
    ) {
      consola.warn(
        `fix crud: "${accessor.name}" accesses "${db.name}" cross-boundary with no existing repo — fix manually`,
      );
      return [];
    }

    const repoName = deriveRepoName(db.name, convention);
    if (repoName in model.elements) {
      consola.warn(
        `fix crud: cannot create repo for "${db.name}" — "${repoName}" already exists`,
      );
      return [];
    }

    if (!db.sourceLocation) return [];

    // New repo + its hop edge insert as one block right after the DB
    // container; the offending direct edge is replaced in place.
    const newDecls = [
      syntax.containerDecl({
        name: repoName,
        label: deriveRepoLabel(db.name),
        kind: "Container",
        external: false,
        description: "",
        tags: [ownerTags[0] ?? "repo"],
        relations: [],
      }),
      syntax.relationDecl(repoName, db.name, {
        technology: rel.technology,
      }),
    ].join("\n");
    routes.push(`${db.name} via new repo ${repoName}`);
    return [
      {
        kind: "insert-after",
        anchor: db.sourceLocation,
        content: `\n${newDecls}`,
      },
      {
        kind: "replace",
        range: rel.sourceLocation,
        // The DB protocol moves to repo → db above; accessor → repo is a
        // service call whose protocol the model doesn't know yet.
        content: syntax.relationDecl(accessor.name, repoName, {
          description: rel.description,
          tags: rel.tags.length > 0 ? rel.tags.join("+") : undefined,
        }),
      },
    ];
  });

  if (edits.length === 0) return undefined;

  return {
    ruleId: "crud",
    description: `Route ${accessor.name} → ${routes.join(", ")}`,
    edits,
  };
};

const fixRepoWithNonDbDeps = (
  repo: Element,
  model: Model,
): FixResult | undefined => {
  const nonDbRels = repo.relations.filter(
    (r) => !isDatabaseElement(targetOf(model, r)),
  );
  if (nonDbRels.length === 0) return undefined;

  const edits: SourceEdit[] = nonDbRels.flatMap((rel): SourceEdit[] =>
    rel.sourceLocation ? [{ kind: "remove", range: rel.sourceLocation }] : [],
  );
  if (edits.length === 0) return undefined;

  return {
    ruleId: "crud",
    description: `Remove non-database dependencies from repo ${repo.name}`,
    edits,
  };
};

/**
 * Database per CRUD-service: containers без repo-tag не должны напрямую
 * обращаться к databases. Доступ через repo/relay прокси. Repo-контейнеры
 * наоборот должны только базы трогать (no external deps).
 */
export const crudRule: RuleDefinition<CrudOptions> = {
  name: "crud",
  description:
    "Direct database access only through repo/relay containers; repos must access databases only",
  rationale:
    "Mixing business logic with raw SQL or storage calls couples a domain service to its persistence schema and makes both harder to evolve. Funnelling data access through a dedicated repo/relay container standardises the API surface (one CRUD endpoint per data store), lets the DB owner optimise indexes and query patterns for a known shape, and lines up with the Single Responsibility and Common Closure principles — services hold logic, repos hold persistence.",
  examples: [
    {
      label: "bad",
      source: `Container(orders, "Orders", "domain logic")
ContainerDb(orders_db, "Orders DB", "PostgreSQL")
Rel(orders, orders_db, "SQL")`,
      note: "`orders` has no repo tag and reaches the DB directly.",
    },
    {
      label: "good",
      source: `Container(orders, "Orders", "domain logic")
Container(orders_repo, "Orders Repo", $tags="repo")
ContainerDb(orders_db, "Orders DB", "PostgreSQL")
Rel(orders, orders_repo, "fetches/saves")
Rel(orders_repo, orders_db, "SQL")`,
    },
  ],
  adrPath: "ADRs/Database per CRUD-service.md",

  check(model, options) {
    const violations: Violation[] = [];

    for (const element of allElements(model)) {
      const dbRelations = element.relations.filter((r) =>
        isDatabaseElement(targetOf(model, r)),
      );
      const isRepoContainer = isRepo(element, options);

      if (!isRepoContainer && dbRelations.length > 0) {
        // Anchor on the first direct-db edge — lint-style click jumps
        // to the `Rel(...)` that broke the rule. Related anchors list
        // every DB this element directly touches.
        const firstEdge = dbRelations[0];
        const related: RelatedLocation[] = [];
        for (const r of dbRelations) {
          const db = getElement(model, r.to);
          if (db?.sourceLocation) {
            related.push({
              sourceLocation: db.sourceLocation,
              message: `database: ${r.to}`,
            });
          }
        }
        violations.push({
          target: element.name,
          targetKind: "element" as const,
          message: `directly accesses database ${dbRelations.map((r) => r.to).join(", ")} — add a repo or relay`,
          ...(firstEdge.sourceLocation
            ? { sourceLocation: firstEdge.sourceLocation }
            : {}),
          ...(related.length > 0 ? { relatedLocations: related } : {}),
        });
      }

      const nonDbRels = element.relations.filter(
        (r) => !isDatabaseElement(targetOf(model, r)),
      );
      if (isRepoContainer && nonDbRels.length > 0) {
        const nonDbTargets = nonDbRels.map((r) => r.to).join(", ");
        const firstEdge = nonDbRels[0];
        const related: RelatedLocation[] = [];
        for (const r of nonDbRels) {
          const target = getElement(model, r.to);
          if (target?.sourceLocation) {
            related.push({
              sourceLocation: target.sourceLocation,
              message: `non-db dependency: ${r.to}`,
            });
          }
        }
        violations.push({
          target: element.name,
          targetKind: "element" as const,
          message: `repo has non-database dependencies: ${nonDbTargets} — repos should only access databases`,
          ...(firstEdge.sourceLocation
            ? { sourceLocation: firstEdge.sourceLocation }
            : {}),
          ...(related.length > 0 ? { relatedLocations: related } : {}),
        });
      }
    }

    return violations;
  },

  fix(ctx) {
    const { model, violations, syntax, options } = ctx;
    const convention = detectNamingConvention(model);
    const results: FixResult[] = [];

    for (const violation of violations) {
      const element = model.elements[violation.target];
      if (!element) continue;

      const fix = isRepo(element, options)
        ? fixRepoWithNonDbDeps(element, model)
        : fixNonRepoAccessesDb(element, model, syntax, options, convention);
      if (fix) results.push(fix);
    }

    return results;
  },
};
