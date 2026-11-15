import { fc, test } from "@fast-check/vitest";
import consola from "consola";

import { plantumlSyntax } from "../../src/formats/plantuml/syntax";
import { structurizrDslSyntax } from "../../src/formats/structurizr/syntax";
import { dbPerServiceRule } from "../../src/rules";
import { applyEdits } from "../../src/rules/lib/applyEdits";
import { loadPumlString } from "../helpers/loadPumlString";
import type { ElementSpec } from "../helpers/makeModel";
import { makeModel } from "../helpers/makeModel";

const nameArb = fc
  .string({ minLength: 2, maxLength: 8 })
  .filter((s) => /^[a-z][a-z0-9_]*$/.test(s));

const dbSpec = (name = "orders_db", label = "Orders DB"): ElementSpec => ({
  name,
  label,
  kind: "ContainerDb",
});

const buildModel = (elements: ElementSpec[]) => makeModel({ elements });

const STDLIB =
  "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml";

const pumlFix = async (puml: string, violationElement: string) => {
  const { model, source } = await loadPumlString(puml);
  const fixes = dbPerServiceRule.fix!({
    model,
    violations: [
      { target: violationElement, targetKind: "element" as const, message: "" },
    ],
    syntax: plantumlSyntax,
    options: undefined,
  });
  const edits = fixes.flatMap((f) => f.edits);
  const { content } = applyEdits(source, edits);
  return { fixes, content };
};

describe("dbPerServiceRule.check", () => {
  it("no violation when each DB has single accessor", () => {
    const model = buildModel([
      { name: "a", relations: [{ to: "db_a" }] },
      dbSpec("db_a"),
    ]);
    expect(dbPerServiceRule.check(model)).toHaveLength(0);
  });

  it("violation when DB shared between multiple containers", () => {
    const model = buildModel([
      { name: "a", relations: [{ to: "shared_db" }] },
      { name: "b", relations: [{ to: "shared_db" }] },
      dbSpec("shared_db"),
    ]);
    const v = dbPerServiceRule.check(model);
    expect(v).toHaveLength(1);
    expect(v[0].target).toBe("shared_db");
    expect(v[0].message).toContain("a");
    expect(v[0].message).toContain("b");
  });

  it("non-DB shared is fine", () => {
    const model = buildModel([
      { name: "a", relations: [{ to: "common" }] },
      { name: "b", relations: [{ to: "common" }] },
      { name: "common" },
    ]);
    expect(dbPerServiceRule.check(model)).toHaveLength(0);
  });

  it("primary anchor points at the DB element declaration, not at any accessor edge", () => {
    // The conceptual location of "this DB has too many owners" is the
    // DB declaration. Anchoring at one of the edges (as the rule
    // historically did) sent every dbPerService violation to whichever
    // Rel(...) happened to be registered first — which is meaningless
    // for the consumer trying to understand the violation.
    const dbLoc = {
      file: "arch.puml",
      start: { line: 10, col: 1, offset: 100 },
      end: { line: 10, col: 25, offset: 124 },
    };
    const edgeLoc = {
      file: "arch.puml",
      start: { line: 25, col: 1, offset: 400 },
      end: { line: 25, col: 30, offset: 429 },
    };
    const model = buildModel([
      { name: "a", relations: [{ to: "shared_db", sourceLocation: edgeLoc }] },
      { name: "b", relations: [{ to: "shared_db" }] },
      { ...dbSpec("shared_db"), sourceLocation: dbLoc },
    ]);
    const [v] = dbPerServiceRule.check(model);
    expect(v.sourceLocation).toEqual(dbLoc);
  });

  it("treats ComponentDb the same as ContainerDb (shared DB detection)", () => {
    // The C4 stdlib distinguishes ContainerDb (level-2) from
    // ComponentDb (level-3); both denote data stores. The rule
    // should fire on either kind being shared between multiple
    // accessors, not just ContainerDb.
    const model = buildModel([
      { name: "a", relations: [{ to: "shared_comp_db" }] },
      { name: "b", relations: [{ to: "shared_comp_db" }] },
      { name: "shared_comp_db", kind: "ComponentDb" },
    ]);
    const v = dbPerServiceRule.check(model);
    expect(v).toHaveLength(1);
    expect(v[0].target).toBe("shared_comp_db");
  });

  it("each accessor edge becomes a related location with accessor name as label", () => {
    const edgeA = {
      file: "arch.puml",
      start: { line: 25, col: 1, offset: 400 },
      end: { line: 25, col: 30, offset: 429 },
    };
    const edgeB = {
      file: "arch.puml",
      start: { line: 26, col: 1, offset: 460 },
      end: { line: 26, col: 30, offset: 489 },
    };
    const model = buildModel([
      { name: "a", relations: [{ to: "shared_db", sourceLocation: edgeA }] },
      { name: "b", relations: [{ to: "shared_db", sourceLocation: edgeB }] },
      dbSpec("shared_db"),
    ]);
    const [v] = dbPerServiceRule.check(model);
    expect(v.relatedLocations).toEqual([
      { sourceLocation: edgeA, message: "accessor: a" },
      { sourceLocation: edgeB, message: "accessor: b" },
    ]);
  });
});

describe("dbPerServiceRule.fix", () => {
  it("returns empty for empty violations", async () => {
    const { model } = await loadPumlString(
      ["@startuml", STDLIB, "@enduml"].join("\n"),
    );
    expect(
      dbPerServiceRule.fix!({
        model,
        violations: [],
        syntax: plantumlSyntax,
        options: undefined,
      }),
    ).toEqual([]);
  });

  it("returns no fix when db has one accessor", async () => {
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orders_repo, "Repo", $tags="repo")',
      'ContainerDb(orders_db, "DB")',
      'Rel(orders_repo, orders_db, "")',
      "@enduml",
    ].join("\n");
    const { fixes } = await pumlFix(puml, "orders_db");
    expect(fixes).toHaveLength(0);
  });

  it("redirects the non-owner accessor through the repo-tagged owner", async () => {
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orders_repo, "Repo", $tags="repo")',
      'Container(payments, "Payments")',
      'ContainerDb(orders_db, "DB")',
      'Rel(orders_repo, orders_db, "")',
      'Rel(payments, orders_db, "")',
      "@enduml",
    ].join("\n");
    const { fixes, content } = await pumlFix(puml, "orders_db");
    expect(fixes).toHaveLength(1);
    expect(fixes[0].ruleId).toBe("dbPerService");
    expect(content).toContain("Rel(payments, orders_repo");
    expect(content).not.toMatch(/Rel\(payments, orders_db,\s*""\)/);
    // Owner's edge stays untouched
    expect(content).toContain('Rel(orders_repo, orders_db, "")');
  });

  it("warns when multiple owners are tagged and uses the first one", async () => {
    const warn = vi.spyOn(consola, "warn").mockImplementation(() => {});
    const puml = [
      "@startuml",
      STDLIB,
      'Container(repo_a, "A", $tags="repo")',
      'Container(repo_b, "B", $tags="repo")',
      'ContainerDb(orders_db, "DB")',
      'Rel(repo_a, orders_db, "")',
      'Rel(repo_b, orders_db, "")',
      "@enduml",
    ].join("\n");
    const { content } = await pumlFix(puml, "orders_db");
    expect(warn).toHaveBeenCalled();
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain("multiple tagged accessors");
    expect(msg).toContain("repo_a");
    expect(msg).toContain("repo_b");
    // repo_b gets rewired through repo_a (first tagged owner)
    expect(content).toContain("Rel(repo_b, repo_a");
  });

  it("warns when no accessor is tagged and falls back to the first one", async () => {
    const warn = vi.spyOn(consola, "warn").mockImplementation(() => {});
    const puml = [
      "@startuml",
      STDLIB,
      'Container(alpha, "A")',
      'Container(beta, "B")',
      'ContainerDb(orders_db, "DB")',
      'Rel(alpha, orders_db, "")',
      'Rel(beta, orders_db, "")',
      "@enduml",
    ].join("\n");
    const { content } = await pumlFix(puml, "orders_db");
    expect(warn).toHaveBeenCalled();
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain("no repo/relay tagged accessor");
    // beta gets rewired through alpha (first in declaration order)
    expect(content).toContain("Rel(beta, alpha");
  });

  it("emits no warning when only one accessor is tagged", async () => {
    const warn = vi.spyOn(consola, "warn").mockImplementation(() => {});
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orders_repo, "Repo", $tags="repo")',
      'Container(payments, "Payments")',
      'ContainerDb(orders_db, "DB")',
      'Rel(orders_repo, orders_db, "")',
      'Rel(payments, orders_db, "")',
      "@enduml",
    ].join("\n");
    await pumlFix(puml, "orders_db");
    expect(warn).not.toHaveBeenCalled();
  });

  it("requires both name AND kind=ContainerDb to pick the violated element", async () => {
    // A non-DB element shares its name with the violation — fix should
    // NOT touch it because the rule only redirects DB accessors.
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orders_db, "Imposter")',
      'Container(svc, "Service")',
      'Rel(svc, orders_db, "")',
      "@enduml",
    ].join("\n");
    const { fixes } = await pumlFix(puml, "orders_db");
    expect(fixes).toHaveLength(0);
  });

  it("silently skips a violation whose element is not in the model", async () => {
    const { model } = await loadPumlString(
      ["@startuml", STDLIB, 'ContainerDb(x, "X")', "@enduml"].join("\n"),
    );
    expect(
      dbPerServiceRule.fix!({
        model,
        violations: [
          { target: "ghost", targetKind: "element" as const, message: "" },
        ],
        syntax: plantumlSyntax,
        options: undefined,
      }),
    ).toHaveLength(0);
  });

  it("emits a replace per non-owner accessor when there are three accessors", async () => {
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orders_repo, "Repo", $tags="repo")',
      'Container(payments, "Payments")',
      'Container(fulfillment, "Fulfillment")',
      'ContainerDb(orders_db, "DB")',
      'Rel(orders_repo, orders_db, "")',
      'Rel(payments, orders_db, "")',
      'Rel(fulfillment, orders_db, "")',
      "@enduml",
    ].join("\n");
    const { content } = await pumlFix(puml, "orders_db");
    expect(content).toContain("Rel(payments, orders_repo");
    expect(content).toContain("Rel(fulfillment, orders_repo");
    // Owner's edge stays
    expect(content).toContain('Rel(orders_repo, orders_db, "")');
  });

  it("description names both the db and the chosen owner", async () => {
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orders_repo, "Repo", $tags="repo")',
      'Container(payments, "Payments")',
      'ContainerDb(orders_db, "DB")',
      'Rel(orders_repo, orders_db, "")',
      'Rel(payments, orders_db, "")',
      "@enduml",
    ].join("\n");
    const { fixes } = await pumlFix(puml, "orders_db");
    expect(fixes[0].description).toContain("orders_db");
    expect(fixes[0].description).toContain("orders_repo");
  });

  it("emits FixResult per violated db when fixing many at once", async () => {
    const puml = [
      "@startuml",
      STDLIB,
      'Container(repo_a, "A", $tags="repo")',
      'Container(repo_b, "B", $tags="repo")',
      'Container(svc1, "S1")',
      'Container(svc2, "S2")',
      'ContainerDb(db_a, "DB A")',
      'ContainerDb(db_b, "DB B")',
      'Rel(repo_a, db_a, "")',
      'Rel(svc1, db_a, "")',
      'Rel(repo_b, db_b, "")',
      'Rel(svc2, db_b, "")',
      "@enduml",
    ].join("\n");
    const { model, source } = await loadPumlString(puml);
    const violations = dbPerServiceRule.check(model);
    const fixes = dbPerServiceRule.fix!({
      model,
      violations,
      syntax: plantumlSyntax,
      options: undefined,
    });
    expect(fixes).toHaveLength(2);
    const edits = fixes.flatMap((f) => f.edits);
    const { content } = applyEdits(source, edits);
    expect(content).toContain("Rel(svc1, repo_a");
    expect(content).toContain("Rel(svc2, repo_b");
  });

  it("matches accessors whose tags array contains a repo tag (not requires all)", async () => {
    // `orders_repo` has tags ["legacy", "repo"]. Pin: the includes()
    // semantics on tag membership — without it, the rule would
    // require every ownerTag to be present and miss real repos.
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orders_repo, "Repo", $tags="legacy+repo")',
      'Container(payments, "Payments")',
      'ContainerDb(orders_db, "DB")',
      'Rel(orders_repo, orders_db, "")',
      'Rel(payments, orders_db, "")',
      "@enduml",
    ].join("\n");
    const { content } = await pumlFix(puml, "orders_db");
    expect(content).toContain("Rel(payments, orders_repo");
  });

  it("only includes accessors that actually reach the db (not random accessors)", async () => {
    // `bystander` doesn't touch orders_db. Pin: it must NOT be
    // considered for owner selection or redirect targets.
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orders_repo, "Repo", $tags="repo")',
      'Container(payments, "Payments")',
      'Container(bystander, "Bystander")',
      'ContainerDb(orders_db, "DB")',
      'ContainerDb(other_db, "Other")',
      'Rel(orders_repo, orders_db, "")',
      'Rel(payments, orders_db, "")',
      'Rel(bystander, other_db, "")',
      "@enduml",
    ].join("\n");
    const { content } = await pumlFix(puml, "orders_db");
    expect(content).toContain("Rel(payments, orders_repo");
    // bystander's edge to other_db is intact, no spurious redirect.
    expect(content).toContain("Rel(bystander, other_db");
  });

  it("preserves relation tags via the + separator when redirecting", async () => {
    // Pin: `rel.tags.join("+")` — extra tags on the original edge
    // (e.g. `async`) survive the rewrite intact.
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orders_repo, "Repo", $tags="repo")',
      'Container(payments, "Payments")',
      'ContainerDb(orders_db, "DB")',
      'Rel(orders_repo, orders_db, "")',
      'Rel(payments, orders_db, "", $tags="async")',
      "@enduml",
    ].join("\n");
    const { content } = await pumlFix(puml, "orders_db");
    expect(content).toContain("Rel(payments, orders_repo");
    expect(content).toContain('$tags="async"');
  });

  test.prop([nameArb])("never throws on arbitrary identifiers", async (svc) => {
    const puml = [
      "@startuml",
      STDLIB,
      `Container(${svc}, "S")`,
      'Container(orders_repo, "Repo", $tags="repo")',
      'ContainerDb(orders_db, "DB")',
      `Rel(${svc}, orders_db, "")`,
      'Rel(orders_repo, orders_db, "")',
      "@enduml",
    ].join("\n");
    const { model } = await loadPumlString(puml);
    const violations = dbPerServiceRule.check(model);
    expect(() =>
      dbPerServiceRule.fix!({
        model,
        violations,
        syntax: plantumlSyntax,
        options: undefined,
      }),
    ).not.toThrow();
  });
});

describe("dbPerServiceRule.fix (structurizr syntax)", () => {
  it("emits structurizr DSL content via FormatSyntax helper", () => {
    const rel = structurizrDslSyntax.relationDecl("payments", "orders_repo", {
      technology: "JDBC",
    });
    expect(rel).toBe('payments -> orders_repo "" "JDBC"');
  });
});

describe("dbPerServiceRule.fix — cross-boundary redirect", () => {
  // examples/violations-demo: orders_db is owned by orders_crud and also
  // read by inventory_api from another context.
  const sharedDb = (extraRels: string[]) =>
    [
      "@startuml",
      STDLIB,
      'System_Boundary(orders, "Orders") {',
      '  Container(orders_api, "Orders API")',
      '  Container(orders_crud, "Orders CRUD", $tags="repo")',
      '  ContainerDb(orders_db, "Orders DB")',
      "}",
      'System_Boundary(inventory, "Inventory") {',
      '  Container(inventory_api, "Inventory API")',
      "}",
      'Rel(orders_api, orders_crud, "")',
      'Rel(orders_crud, orders_db, "")',
      'Rel(inventory_api, orders_db, "reads", "SQL")',
      ...extraRels,
      "@enduml",
    ].join("\n");

  it("routes the foreign accessor through the owning context's API, without the DB protocol", async () => {
    const { fixes, content } = await pumlFix(sharedDb([]), "orders_db");
    expect(fixes[0].description).toBe(
      "Redirect access to orders_db through orders_api",
    );
    expect(content).toContain('Rel(inventory_api, orders_api, "reads")');
    expect(content).not.toContain(
      'Rel(inventory_api, orders_api, "reads", "SQL")',
    );
  });

  it("refuses the redirect when it would close a dependency cycle", async () => {
    const warn = vi.spyOn(consola, "warn").mockImplementation(() => {});
    const { fixes } = await pumlFix(
      sharedDb(['Rel(orders_api, inventory_api, "")']),
      "orders_db",
    );
    expect(fixes).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("would create a dependency cycle"),
    );
  });
});
