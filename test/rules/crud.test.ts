import { fc, test } from "@fast-check/vitest";
import consola from "consola";

import { plantumlSyntax } from "../../src/formats/plantuml/syntax";
import { structurizrDslSyntax } from "../../src/formats/structurizr/syntax";
import { crudRule } from "../../src/rules";
import { applyEdits } from "../../src/rules/lib/applyEdits";
import { loadPumlString } from "../helpers/loadPumlString";
import type { BoundarySpec, ElementSpec } from "../helpers/makeModel";
import { makeModel } from "../helpers/makeModel";

const nameArb = fc
  .string({ minLength: 2, maxLength: 8 })
  .filter((s) => /^[a-z][a-z0-9_]*$/.test(s));

const dbSpec = (name = "orders_db", label = "Orders DB"): ElementSpec => ({
  name,
  label,
  kind: "ContainerDb",
});

const buildModel = (elements: ElementSpec[], boundaries?: BoundarySpec[]) =>
  makeModel({ elements, boundaries });

const STDLIB =
  "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml";

const pumlFix = async (
  puml: string,
  violationElement: string,
  options?: Parameters<typeof crudRule.check>[1],
) => {
  const { model, source } = await loadPumlString(puml);
  const fixes = crudRule.fix!({
    model,
    violations: [
      { target: violationElement, targetKind: "element" as const, message: "" },
    ],
    syntax: plantumlSyntax,
    options,
  });
  const edits = fixes.flatMap((f) => f.edits);
  const { content } = applyEdits(source, edits);
  return { fixes, content };
};

describe("crudRule.check", () => {
  it("no violation when only repo accesses DB", () => {
    const model = buildModel([
      { name: "orders_repo", tags: ["repo"], relations: [{ to: "orders_db" }] },
      dbSpec(),
    ]);
    expect(crudRule.check(model)).toHaveLength(0);
  });

  it("violation when non-repo accesses DB", () => {
    const model = buildModel([
      { name: "orders", relations: [{ to: "orders_db" }] },
      dbSpec(),
    ]);
    const v = crudRule.check(model);
    expect(v).toHaveLength(1);
    expect(v[0].target).toBe("orders");
    expect(v[0].message).toMatch(/repo/);
  });

  it("treats ComponentDb the same as ContainerDb (direct-access detection)", () => {
    // The C4 stdlib has both `ContainerDb` (level-2) and
    // `ComponentDb` (level-3) for data stores; the rule must fire
    // on either when a non-repo accesses one directly.
    const model = buildModel([
      { name: "orders", relations: [{ to: "comp_db" }] },
      { name: "comp_db", kind: "ComponentDb" },
    ]);
    const v = crudRule.check(model);
    expect(v).toHaveLength(1);
    expect(v[0].target).toBe("orders");
  });

  it("repos may access ComponentDb without violation, but not non-DB elements", () => {
    // Inverse direction: a repo accessing a ComponentDb is fine
    // (it's a DB). Accessing something else fires the rule.
    const model = buildModel([
      {
        name: "user_repo",
        tags: ["repo"],
        relations: [{ to: "user_comp_db" }, { to: "other_svc" }],
      },
      { name: "user_comp_db", kind: "ComponentDb" },
      { name: "other_svc" },
    ]);
    const v = crudRule.check(model);
    expect(v).toHaveLength(1);
    expect(v[0].message).toMatch(/non-database/);
  });

  it("violation when repo has non-DB dependencies", () => {
    const model = buildModel([
      {
        name: "orders_repo",
        tags: ["repo"],
        relations: [{ to: "orders_db" }, { to: "other_service" }],
      },
      dbSpec(),
      { name: "other_service" },
    ]);
    const v = crudRule.check(model);
    expect(v).toHaveLength(1);
    expect(v[0].message).toMatch(/non-database/);
  });

  it("respects repoTags option", () => {
    const model = buildModel([
      { name: "orders_dao", tags: ["dao"], relations: [{ to: "orders_db" }] },
      dbSpec(),
    ]);
    expect(crudRule.check(model, { repoTags: ["dao"] })).toHaveLength(0);
  });
});

describe("crudRule.fix — non-repo accesses DB", () => {
  it("returns empty for empty violations", () => {
    const model = buildModel([]);
    expect(
      crudRule.fix!({
        model,
        violations: [],
        syntax: plantumlSyntax,
        options: undefined,
      }),
    ).toEqual([]);
  });

  it("redirects accessor through an existing tagged repo", async () => {
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orders, "Orders Service")',
      'Container(orders_repo, "Orders Repo", $tags="repo")',
      'ContainerDb(orders_db, "Orders DB")',
      'Rel(orders, orders_db, "")',
      'Rel(orders_repo, orders_db, "")',
      "@enduml",
    ].join("\n");
    const { content } = await pumlFix(puml, "orders");
    expect(content).toContain("Rel(orders, orders_repo");
    expect(content).not.toMatch(/Rel\(orders, orders_db,\s*""\)/);
  });

  it("redirects through a name-pattern-matched repo and promotes its tag", async () => {
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orders, "Orders Service")',
      'Container(orders_repo, "Orders Repo")',
      'ContainerDb(orders_db, "Orders DB")',
      'Rel(orders, orders_db, "")',
      'Rel(orders_repo, orders_db, "")',
      "@enduml",
    ].join("\n");
    const { content } = await pumlFix(puml, "orders");
    // Existing repo gets re-emitted with the canonical $tags="repo".
    expect(content).toContain('$tags="repo"');
    expect(content).toContain("Rel(orders, orders_repo");
  });

  it("creates a new repo when none exists", async () => {
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orders, "Orders Service")',
      'ContainerDb(orders_db, "Orders DB")',
      'Rel(orders, orders_db, "")',
      "@enduml",
    ].join("\n");
    const { content } = await pumlFix(puml, "orders");
    expect(content).toContain("Container(orders_repo,");
    expect(content).toContain('$tags="repo"');
    expect(content).toContain("Rel(orders_repo, orders_db");
    expect(content).toContain("Rel(orders, orders_repo");
    expect(content).not.toMatch(/Rel\(orders, orders_db,\s*""\)/);
  });

  it("derives the new repo's label from the DB name (strip `_db`, capitalise)", async () => {
    const puml = [
      "@startuml",
      STDLIB,
      'Container(svc, "Service")',
      'ContainerDb(payment_db, "Payment DB")',
      'Rel(svc, payment_db, "")',
      "@enduml",
    ].join("\n");
    const { content } = await pumlFix(puml, "svc");
    expect(content).toContain('Container(payment_repo, "Payment Repo"');
  });

  it("strips Database suffix in camelCase identifiers", async () => {
    const puml = [
      "@startuml",
      STDLIB,
      'Container(svc, "Service")',
      'ContainerDb(paymentDatabase, "Payment DB")',
      'Rel(svc, paymentDatabase, "")',
      "@enduml",
    ].join("\n");
    const { content } = await pumlFix(puml, "svc");
    expect(content).toContain("Container(paymentRepo,");
  });

  it("auto-detects camelCase and uses Repo suffix", async () => {
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orderService, "Service")',
      'ContainerDb(ordersDb, "DB")',
      'Rel(orderService, ordersDb, "")',
      "@enduml",
    ].join("\n");
    const { content } = await pumlFix(puml, "orderService");
    expect(content).toContain("Container(ordersRepo,");
  });

  it("skips and warns when the derived repo name already exists as something else", async () => {
    const warn = vi.spyOn(consola, "warn").mockImplementation(() => {});
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orders, "Orders Service")',
      'Container(orders_repo, "Pre-existing")',
      'ContainerDb(orders_db, "Orders DB")',
      // `orders_repo` does NOT touch orders_db — name collision but not
      // a usable repo. crud-fix should refuse to clobber it.
      'Rel(orders, orders_db, "")',
      "@enduml",
    ].join("\n");
    const { fixes } = await pumlFix(puml, "orders");
    expect(fixes).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it("emits cross-boundary warning when no existing repo and accessor differs from db's boundary", async () => {
    const warn = vi.spyOn(consola, "warn").mockImplementation(() => {});
    const puml = [
      "@startuml",
      STDLIB,
      'Container_Boundary(svc_boundary, "Svc") {',
      '  Container(svc, "Service")',
      "}",
      'Container_Boundary(db_boundary, "DB") {',
      '  ContainerDb(orders_db, "Orders DB")',
      "}",
      'Rel(svc, orders_db, "")',
      "@enduml",
    ].join("\n");
    const { fixes } = await pumlFix(puml, "svc");
    expect(fixes).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain("fix crud");
    expect(msg).toContain("cross-boundary");
    expect(msg).toContain("svc");
    expect(msg).toContain("orders_db");
  });

  it('tags every FixResult with rule="crud" and a human-readable description', async () => {
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orders, "Orders Service")',
      'ContainerDb(orders_db, "Orders DB")',
      'Rel(orders, orders_db, "")',
      "@enduml",
    ].join("\n");
    const { fixes } = await pumlFix(puml, "orders");
    expect(fixes).toHaveLength(1);
    expect(fixes[0].ruleId).toBe("crud");
    expect(fixes[0].description).toContain("orders");
    expect(fixes[0].description).toContain("orders_db");
  });

  it("ignores non-db outbound relations when scoping fix", async () => {
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orders, "Orders Service")',
      'ContainerDb(orders_db, "Orders DB")',
      'Container(audit, "Audit Bus")',
      'Rel(orders, orders_db, "")',
      'Rel(orders, audit, "")',
      "@enduml",
    ].join("\n");
    const { content } = await pumlFix(puml, "orders");
    // The audit edge stays untouched
    expect(content).toContain('Rel(orders, audit, "")');
  });

  it('falls back to "repo" tag when ownerTags is an empty array', async () => {
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orders, "Orders Service")',
      'ContainerDb(orders_db, "Orders DB")',
      'Rel(orders, orders_db, "")',
      "@enduml",
    ].join("\n");
    const { content } = await pumlFix(puml, "orders", { repoTags: [] });
    expect(content).toContain('$tags="repo"');
  });

  it("uses the first repoTag as the new repo's tag when ownerTags is custom", async () => {
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orders, "Orders Service")',
      'ContainerDb(orders_db, "Orders DB")',
      'Rel(orders, orders_db, "")',
      "@enduml",
    ].join("\n");
    const { content } = await pumlFix(puml, "orders", { repoTags: ["dao"] });
    expect(content).toContain('$tags="dao"');
  });
});

describe("crudRule.fix — repo with non-DB deps", () => {
  it("removes the offending non-database edges", async () => {
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orders_repo, "Orders Repo", $tags="repo")',
      'ContainerDb(orders_db, "Orders DB")',
      'Container(audit, "Audit Bus")',
      'Rel(orders_repo, orders_db, "")',
      'Rel(orders_repo, audit, "")',
      "@enduml",
    ].join("\n");
    const { content } = await pumlFix(puml, "orders_repo");
    expect(content).toContain("Rel(orders_repo, orders_db,");
    expect(content).not.toContain("Rel(orders_repo, audit");
  });

  it('tags repo-with-non-db-deps fixes with rule="crud"', async () => {
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orders_repo, "Orders Repo", $tags="repo")',
      'ContainerDb(orders_db, "Orders DB")',
      'Container(audit, "Audit Bus")',
      'Rel(orders_repo, orders_db, "")',
      'Rel(orders_repo, audit, "")',
      "@enduml",
    ].join("\n");
    const { fixes } = await pumlFix(puml, "orders_repo");
    expect(fixes).toHaveLength(1);
    expect(fixes[0].ruleId).toBe("crud");
    expect(fixes[0].description).toMatch(/orders_repo/);
  });
});

describe("crudRule.fix — repo discovery", () => {
  it("ignores an untagged container that does not match name patterns", async () => {
    // `helper` is not a repo by tag or by name. Pin: crud must NOT
    // pick it as a redirect target — should create a fresh repo.
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orders, "Orders Service")',
      'Container(helper, "Helper")',
      'ContainerDb(orders_db, "Orders DB")',
      'Rel(orders, orders_db, "")',
      'Rel(helper, orders_db, "")',
      "@enduml",
    ].join("\n");
    const { content } = await pumlFix(puml, "orders");
    // A fresh orders_repo container should be created (not redirect through helper).
    expect(content).toContain("Container(orders_repo,");
    expect(content).not.toContain("Rel(orders, helper");
  });

  it("requires the candidate repo to actually reach the same db", async () => {
    // `unrelated_repo` is repo-tagged but talks to a DIFFERENT db. Pin:
    // crud must NOT redirect orders → unrelated_repo for orders_db
    // accesses; it has to create a fresh repo.
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orders, "Orders Service")',
      'Container(unrelated_repo, "Unrelated Repo", $tags="repo")',
      'ContainerDb(orders_db, "Orders DB")',
      'ContainerDb(other_db, "Other DB")',
      'Rel(orders, orders_db, "")',
      'Rel(unrelated_repo, other_db, "")',
      "@enduml",
    ].join("\n");
    const { content } = await pumlFix(puml, "orders");
    expect(content).toContain("Container(orders_repo,");
    expect(content).not.toContain("Rel(orders, unrelated_repo");
  });

  it("does not consider the accessor itself when scanning for an existing repo", async () => {
    // Pin: `c !== accessor` guard — without it, a service that already
    // touches its own db could be "rescued" by pointing at itself.
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orders, "Orders Service")',
      'ContainerDb(orders_db, "Orders DB")',
      'Rel(orders, orders_db, "")',
      "@enduml",
    ].join("\n");
    const { content } = await pumlFix(puml, "orders");
    expect(content).toContain("Container(orders_repo,");
    expect(content).not.toMatch(/Rel\(orders, orders,/);
  });
});

describe("crudRule.fix — edge cases", () => {
  it("silently skips a violation that names a non-existent element", async () => {
    const puml = [
      "@startuml",
      STDLIB,
      'ContainerDb(orders_db, "Orders DB")',
      "@enduml",
    ].join("\n");
    const { model } = await loadPumlString(puml);
    expect(
      crudRule.fix!({
        model,
        violations: [
          { target: "ghost", targetKind: "element" as const, message: "" },
        ],
        syntax: plantumlSyntax,
        options: undefined,
      }),
    ).toHaveLength(0);
  });

  it("description names the route the fix creates", async () => {
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orders, "Orders Service")',
      'ContainerDb(orders_db, "Orders DB")',
      'Rel(orders, orders_db, "")',
      "@enduml",
    ].join("\n");
    const { fixes } = await pumlFix(puml, "orders");
    expect(fixes[0].description).toBe(
      "Route orders → orders_db via new repo orders_repo",
    );
  });

  it("keeps the DB protocol on repo → db, not on the rewired service edge", async () => {
    // Regression: the rewired accessor edge inherited "SQL", so the model
    // claimed a service called its repo over SQL.
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orders, "Orders Service")',
      'ContainerDb(orders_db, "Orders DB")',
      'Rel(orders, orders_db, "reads", "SQL")',
      "@enduml",
    ].join("\n");
    const { content } = await pumlFix(puml, "orders");
    expect(content).toContain('Rel(orders_repo, orders_db, "", "SQL")');
    expect(content).toContain('Rel(orders, orders_repo, "reads")');
    expect(content).not.toMatch(/Rel\(orders, orders_repo, "reads", "SQL"\)/);
  });

  describe("cross-boundary redirect", () => {
    // examples/violations-demo: inventory_api reads the Orders DB directly.
    // The fix routes it through the Orders context's public API — unless
    // that API already calls inventory_api, where the rewire is a cycle.
    const contexts = (extraRels: string[]) =>
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
        'Rel(inventory_api, orders_db, "", "SQL")',
        ...extraRels,
        "@enduml",
      ].join("\n");

    it("routes through the owning context's API", async () => {
      const { fixes, content } = await pumlFix(contexts([]), "inventory_api");
      expect(fixes[0].description).toBe(
        "Route inventory_api → orders_db via orders_api",
      );
      expect(content).toContain('Rel(inventory_api, orders_api, "")');
    });

    it("refuses the redirect when it would close a dependency cycle", async () => {
      const warn = vi.spyOn(consola, "warn").mockImplementation(() => {});
      const { fixes } = await pumlFix(
        contexts(['Rel(orders_api, inventory_api, "")']),
        "inventory_api",
      );
      expect(fixes).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("would create a dependency cycle"),
      );
    });
  });

  // Note: `relationDecl(from, to, tech)` currently emits `tech` in
  // C4-PUML positional 3 (label slot), conflating description and
  // technology. That's a pre-existing FormatSyntax shortcoming
  // independent of the range-edit refactor — track separately so we
  // can split the helper into `description` + `technology` params.

  test.prop([nameArb])(
    "never throws for arbitrary service identifiers",
    async (svc) => {
      const puml = [
        "@startuml",
        STDLIB,
        `Container(${svc}, "Service")`,
        'ContainerDb(orders_db, "Orders DB")',
        `Rel(${svc}, orders_db, "")`,
        "@enduml",
      ].join("\n");
      const { model } = await loadPumlString(puml);
      const v = crudRule.check(model);
      expect(() =>
        crudRule.fix!({
          model,
          violations: v,
          syntax: plantumlSyntax,
          options: undefined,
        }),
      ).not.toThrow();
    },
  );
});

describe("crudRule.fix — UTF-16 offset semantics", () => {
  it("rewires correctly when source contains cyrillic and emoji before the edit point", async () => {
    // Regression: SourcePosition.offset is a UTF-16 code unit index,
    // not a UTF-8 byte offset. If `applyEdits` ever switched to
    // byte-based slicing (Buffer.from(...).slice), multibyte
    // characters BEFORE the edited line would shift the offsets and
    // the splice would land mid-glyph. Pin: cyrillic + emoji labels
    // round-trip cleanly through `--fix` rewrite.
    const puml = [
      "@startuml",
      STDLIB,
      'Container(orders, "Сервис заказов 📦")',
      'ContainerDb(orders_db, "База данных 💾")',
      'Rel(orders, orders_db, "читает")',
      "@enduml",
    ].join("\n");
    const { content } = await pumlFix(puml, "orders");
    // Original labels survive byte-for-byte.
    expect(content).toContain('Container(orders, "Сервис заказов 📦")');
    expect(content).toContain('ContainerDb(orders_db, "База данных 💾")');
    // New repo container injected.
    expect(content).toContain("Container(orders_repo,");
    // Original Rel was rewired (not duplicated, not corrupted).
    expect(content).not.toMatch(/Rel\(orders, orders_db,\s*"читает"\)/);
    expect(content).toContain("Rel(orders, orders_repo");
  });
});

describe("crudRule.fix (structurizr syntax)", () => {
  it("emits structurizr DSL content via FormatSyntax helper", () => {
    // Synth model has no sourceLocation → fix returns no edits. The
    // syntax helper itself is what we pin here — actual fix path is
    // covered end-to-end by PUML tests above; structurizr in-place
    // editing uses the same applier.
    const decl = structurizrDslSyntax.containerDecl({
      name: "orders_repo",
      label: "Orders Repo",
      kind: "Container",
      external: false,
      description: "",
      tags: ["repo"],
      relations: [],
    });
    expect(decl).toContain('orders_repo = container "Orders Repo"');
    expect(decl).toContain('tags "repo"');
    const rel = structurizrDslSyntax.relationDecl("orders", "orders_repo", {
      technology: "PostgreSQL",
    });
    expect(rel).toBe('orders -> orders_repo "" "PostgreSQL"');
  });
});
