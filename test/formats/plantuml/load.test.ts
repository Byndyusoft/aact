import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import path from "pathe";

import { IncludeNotFoundError } from "../../../src/formats/_shared/includeError";
import { load } from "../../../src/formats/plantuml/load";
import { plantumlSyntax } from "../../../src/formats/plantuml/syntax";
import type { Model } from "../../../src/model";
import { allElements, getElement } from "../../../src/model";

describe("PlantUML load — fixture", () => {
  let model: Model;

  beforeAll(async () => {
    const result = await load("fixtures/architecture/boundaries.puml");
    model = result.model;
  });

  it("loads containers", () => {
    expect(allElements(model).length).toBeGreaterThan(0);
  });

  it("loads boundaries", () => {
    expect(Object.values(model.boundaries).length).toBeGreaterThan(0);
  });

  it("builds relations between containers", () => {
    const relationsCount = allElements(model).reduce(
      (sum, c) => sum + c.relations.length,
      0,
    );
    expect(relationsCount).toBeGreaterThan(0);
  });

  it("assigns boundary children correctly", () => {
    for (const boundary of Object.values(model.boundaries)) {
      expect(
        boundary.elementNames.length + boundary.boundaryNames.length,
      ).toBeGreaterThan(0);
    }
  });

  it("rejects with ENOENT for nonexistent file", async () => {
    await expect(load("nonexistent.puml")).rejects.toThrow(/ENOENT/);
  });
});

describe("PlantUML load — unit", () => {
  let tmpDir: string;
  beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "aact-puml-"));
  });

  const writeFixture = async (
    name: string,
    content: string,
  ): Promise<string> => {
    const file = path.join(tmpDir, name);
    await writeFile(file, content, "utf8");
    return file;
  };

  const loadFromContent = async (
    name: string,
    content: string,
  ): Promise<Model> => {
    const file = await writeFixture(name, content);
    const result = await load(file);
    return result.model;
  };

  it("fails loudly on PlantUML parser errors", async () => {
    const file = await writeFixture(
      "bad.puml",
      ["@startuml", 'Container(api, "API"', "@enduml"].join("\n"),
    );

    await expect(load(file)).rejects.toThrow(/Failed to parse PlantUML/);
  });

  it("expands local !include files before parsing", async () => {
    await writeFixture("people.puml", 'Person(customer, "Customer")\n');
    const file = await writeFixture(
      "main-include.puml",
      [
        "@startuml",
        "!include people.puml",
        'Container(api, "API")',
        'Rel(customer, api, "Uses")',
        "@enduml",
      ].join("\n"),
    );

    const result = await load(file);

    expect(result.model.elements.customer?.relations[0]).toEqual(
      expect.objectContaining({ to: "api", description: "Uses" }),
    );
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ message: expect.stringMatching(/include/i) }),
    );
  });

  it("names the missing include, not the file that referenced it", async () => {
    // Regression: a missing !include used to surface as a bare ENOENT,
    // which the CLI collapsed into "Architecture file not found:
    // <entry point>" — pointing at the one file that does exist.
    const file = await writeFixture(
      "main-missing-include.puml",
      [
        "@startuml",
        "  !include partials/missing.puml",
        'Container(api, "API")',
        "@enduml",
      ].join("\n"),
    );

    const error = await load(file).catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(IncludeNotFoundError);
    expect((error as IncludeNotFoundError).site).toEqual({
      missingPath: path.join(tmpDir, "partials", "missing.puml"),
      target: "partials/missing.puml",
      includedFrom: file,
      line: 2,
      column: 3,
    });
  });

  it("reports the innermost missing include of a nested chain", async () => {
    await writeFixture("level1.puml", "!include level2.puml\n");
    const file = await writeFixture(
      "main-nested-include.puml",
      ["@startuml", "!include level1.puml", "@enduml"].join("\n"),
    );

    const error = await load(file).catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(IncludeNotFoundError);
    expect((error as IncludeNotFoundError).site).toMatchObject({
      missingPath: path.join(tmpDir, "level2.puml"),
      includedFrom: path.join(tmpDir, "level1.puml"),
      line: 1,
    });
  });

  it("expands local !include_once only once", async () => {
    await writeFixture("shared-once.puml", 'Person(customer, "Customer")\n');
    const file = await writeFixture(
      "main-include-once.puml",
      [
        "@startuml",
        "!include_once shared-once.puml",
        "!include_once shared-once.puml",
        'Container(api, "API")',
        'Rel(customer, api, "Uses")',
        "@enduml",
      ].join("\n"),
    );

    const result = await load(file);

    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ kind: "duplicate-element-name" }),
    );
    expect(result.model.elements.customer?.relations[0]?.to).toBe("api");
  });

  it("expands local !include_many every time", async () => {
    await writeFixture(
      "shared-many.puml",
      [
        'Person(customer_many, "Customer")',
        'Rel(customer_many, api, "Uses")',
      ].join("\n"),
    );
    const file = await writeFixture(
      "main-include-many.puml",
      [
        "@startuml",
        'Container(api, "API")',
        "!include_many shared-many.puml",
        "!include_many shared-many.puml",
        "@enduml",
      ].join("\n"),
    );

    const result = await load(file);

    expect(result.model.elements.customer_many?.relations).toHaveLength(2);
    expect(
      result.model.elements.customer_many?.relations.every(
        (r) => r.to === "api",
      ),
    ).toBe(true);
  });

  it("surfaces pre-parse notes as loader warnings", async () => {
    const file = await writeFixture(
      "deployment-note.puml",
      [
        "@startuml",
        'Deployment_Node(prod, "Prod") {',
        '  Container(api, "API")',
        "}",
        'Person(user, "User")',
        "@enduml",
      ].join("\n"),
    );

    const result = await load(file);

    expect(result.issues).toContainEqual(
      expect.objectContaining({
        kind: "loader-warning",
        source: "plantuml",
        code: "preparse-info",
        message: expect.stringMatching(/Deployment/),
      }),
    );
  });

  it("strips the $tags= prefix and surfaces as Container.tags", async () => {
    const model = await loadFromContent(
      "tags.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(svc, "Svc", "", "", $tags="acl")',
        "@enduml",
      ].join("\n"),
    );
    expect(getElement(model, "svc")?.tags).toEqual(["acl"]);
  });

  it("swaps from/to for Rel_Back relations", async () => {
    const model = await loadFromContent(
      "rel-back.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(a, "A")',
        'Container(b, "B")',
        // Rel_Back(a, b) means logically "b -> a" — the loader must swap.
        'Rel_Back(a, b, "test")',
        "@enduml",
      ].join("\n"),
    );
    expect(getElement(model, "b")?.relations[0].to).toBe("a");
  });

  it("leaves non-Rel_Back relations untouched", async () => {
    const model = await loadFromContent(
      "rel.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(a, "A")',
        'Container(b, "B")',
        'Rel(a, b, "test")',
        "@enduml",
      ].join("\n"),
    );
    expect(getElement(model, "a")?.relations[0].to).toBe("b");
  });

  it("recognises ContainerDb kind from PUML", async () => {
    const model = await loadFromContent(
      "db.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'ContainerDb(orders_db, "Orders DB")',
        "@enduml",
      ].join("\n"),
    );
    expect(getElement(model, "orders_db")?.kind).toBe("ContainerDb");
  });

  it("recognises System_Ext as kind=System + external=true", async () => {
    const model = await loadFromContent(
      "ext.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'System_Ext(ext, "External System")',
        "@enduml",
      ].join("\n"),
    );
    const ext = getElement(model, "ext");
    expect(ext?.kind).toBe("System");
    expect(ext?.external).toBe(true);
  });

  it("recognises Component kind from PUML", async () => {
    const model = await loadFromContent(
      "comp.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Component(parser, "Parser")',
        "@enduml",
      ].join("\n"),
    );
    expect(getElement(model, "parser")?.kind).toBe("Component");
  });

  it("renders System kind from PUML", async () => {
    const model = await loadFromContent(
      "system.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'System(core, "Core System")',
        "@enduml",
      ].join("\n"),
    );
    expect(getElement(model, "core")?.kind).toBe("System");
  });

  it("renders Person kind from PUML", async () => {
    const model = await loadFromContent(
      "person.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Person(user, "End User")',
        "@enduml",
      ].join("\n"),
    );
    expect(getElement(model, "user")?.kind).toBe("Person");
  });

  it.each([
    ["ContainerQueue", "ContainerQueue"],
    ["Container_Ext", "Container"],
    ["ContainerDb_Ext", "ContainerDb"],
    ["ContainerQueue_Ext", "ContainerQueue"],
    ["ComponentDb", "ComponentDb"],
    ["ComponentQueue", "ComponentQueue"],
    ["Component_Ext", "Component"],
    ["ComponentDb_Ext", "ComponentDb"],
    ["ComponentQueue_Ext", "ComponentQueue"],
    ["Person_Ext", "Person"],
    ["SystemDb", "System"],
    ["SystemQueue", "System"],
    ["SystemDb_Ext", "System"],
    ["SystemQueue_Ext", "System"],
  ])(
    "filterElements recognises %s macro → kind=%s",
    async (macro, expectedKind) => {
      // Covers every entry in filterElements' CONTAINER_LIKE_NAMES /
      // CONTEXT_NAMES sets. Without these tests, Stryker can mutate any
      // string literal in those sets to "" and PUML containing that macro
      // would still load (silently dropped) — bug masquerading as design.
      const model = await loadFromContent(
        `${macro.toLowerCase()}.puml`,
        [
          "@startuml",
          "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
          `${macro}(elem, "Label")`,
          "@enduml",
        ].join("\n"),
      );
      expect(getElement(model, "elem")?.kind).toBe(expectedKind);
    },
  );

  it("Container without technology arg has technology=undefined", async () => {
    const model = await loadFromContent(
      "no-tech.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(svc, "Svc")',
        "@enduml",
      ].join("\n"),
    );
    expect(getElement(model, "svc")?.technology).toBeUndefined();
  });

  it("Container with technology arg preserves it", async () => {
    const model = await loadFromContent(
      "tech-arg.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(svc, "Svc", "Spring Boot")',
        "@enduml",
      ].join("\n"),
    );
    expect(getElement(model, "svc")?.technology).toBe("Spring Boot");
  });

  it("Person ignores technology slot (Context, no techn field)", async () => {
    // Pin: technology populated только когда `techn` IN el AND non-empty.
    // Person doesn't have techn → must stay undefined.
    const model = await loadFromContent(
      "person-no-tech.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Person(user, "User")',
        "@enduml",
      ].join("\n"),
    );
    expect(getElement(model, "user")?.technology).toBeUndefined();
  });

  it("Container with explicit description fills the description field", async () => {
    const model = await loadFromContent(
      "with-desc.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(svc, "Svc", "tech", "Detailed purpose")',
        "@enduml",
      ].join("\n"),
    );
    expect(getElement(model, "svc")?.description).toBe("Detailed purpose");
  });

  it("Container without description has empty-string description (covers el.descr || '')", async () => {
    const model = await loadFromContent(
      "no-desc.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(svc, "Svc")',
        "@enduml",
      ].join("\n"),
    );
    expect(getElement(model, "svc")?.description).toBe("");
  });

  it("Rel preserves description from label arg", async () => {
    const model = await loadFromContent(
      "rel-desc.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(a, "A")',
        'Container(b, "B")',
        'Rel(a, b, "calls")',
        "@enduml",
      ].join("\n"),
    );
    expect(getElement(model, "a")?.relations[0].description).toBe("calls");
  });

  it("Rel without technology has technology=undefined (covers rel.techn || undefined)", async () => {
    const model = await loadFromContent(
      "rel-no-tech.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(a, "A")',
        'Container(b, "B")',
        'Rel(a, b, "")',
        "@enduml",
      ].join("\n"),
    );
    expect(getElement(model, "a")?.relations[0].technology).toBeUndefined();
  });

  it("Rel without label has description=undefined", async () => {
    const model = await loadFromContent(
      "rel-empty-label.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(a, "A")',
        'Container(b, "B")',
        'Rel(a, b, "")',
        "@enduml",
      ].join("\n"),
    );
    expect(getElement(model, "a")?.relations[0].description).toBeUndefined();
  });

  it("Rel preserves technology from techn arg", async () => {
    const model = await loadFromContent(
      "rel-with-tech.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(a, "A")',
        'Container(b, "B")',
        'Rel(a, b, "calls", "REST")',
        "@enduml",
      ].join("\n"),
    );
    expect(getElement(model, "a")?.relations[0].technology).toBe("REST");
  });

  it("Rel without tags has tags=[] (covers parseCsvTags empty)", async () => {
    const model = await loadFromContent(
      "rel-no-tags.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(a, "A")',
        'Container(b, "B")',
        'Rel(a, b, "x")',
        "@enduml",
      ].join("\n"),
    );
    expect(getElement(model, "a")?.relations[0].tags).toEqual([]);
  });

  it("Comment elements are ignored by normalizeRelBack (covers instanceof Comment continue)", async () => {
    // Comments before Rel_Back must not interfere with swap logic.
    const model = await loadFromContent(
      "comment-rel-back.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        "' top-level comment",
        'Container(a, "A")',
        'Container(b, "B")',
        "' another comment",
        'Rel_Back(a, b, "test")',
        "@enduml",
      ].join("\n"),
    );
    // Rel_Back(a,b) → swap → b → a
    expect(getElement(model, "b")?.relations[0].to).toBe("a");
  });

  it("non-Rel_Back relation in normalizeRelBack scope stays untouched (instanceof Stdlib_C4_Dynamic_Rel guard)", async () => {
    const model = await loadFromContent(
      "rel-normal-untouched.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(a, "A")',
        'Container(b, "B")',
        'Rel(a, b, "x")',
        "@enduml",
      ].join("\n"),
    );
    expect(getElement(model, "a")?.relations[0].to).toBe("b");
    expect(getElement(model, "b")?.relations ?? []).toHaveLength(0);
  });

  it.each([
    ["System_Boundary", "System"],
    ["Container_Boundary", "Container"],
    ["Enterprise_Boundary", "Enterprise"],
    // Component_Boundary intentionally absent — it is NOT in the C4-PlantUML
    // stdlib (verified against the upstream macro definitions and README:
    // "the available boundary macros are Boundary, Enterprise_Boundary,
    // System_Boundary, Container_Boundary"). The canonical way to group
    // components is `Container_Boundary`, not a non-existent
    // `Component_Boundary`.
  ])(
    "filterElements recognises %s → boundary.kind=%s",
    async (macro, expectedKind) => {
      const model = await loadFromContent(
        `${macro.toLowerCase()}.puml`,
        [
          "@startuml",
          "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
          `${macro}(b1, "Boundary") {`,
          `  Container(c, "C")`,
          "}",
          "@enduml",
        ].join("\n"),
      );
      expect(model.boundaries.b1?.kind).toBe(expectedKind);
    },
  );

  it("preserves official relation descr slot without treating it as tags", async () => {
    const model = await loadFromContent(
      "rel-descr.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(a, "A")',
        'Container(b, "B")',
        'Rel(a, b, "label", "REST", "opens dashboard")',
        "@enduml",
      ].join("\n"),
    );
    const rel = getElement(model, "a")?.relations[0];
    expect(rel?.tags).toEqual([]);
    expect(rel?.properties?.["plantuml.descr"]).toBe("opens dashboard");
  });

  it("parses relation technology from the 4th arg", async () => {
    const model = await loadFromContent(
      "tech.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(a, "A")',
        'Container(b, "B")',
        'Rel(a, b, "label", "REST")',
        "@enduml",
      ].join("\n"),
    );
    expect(getElement(model, "a")?.relations[0].technology).toBe("REST");
  });

  it("each new container starts with an empty relations array", async () => {
    const model = await loadFromContent(
      "empty-rel.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(a, "A")',
        "@enduml",
      ].join("\n"),
    );
    expect(getElement(model, "a")?.relations).toEqual([]);
  });

  it("model.elements Record is sorted alphabetically (buildModel guarantee)", async () => {
    const model = await loadFromContent(
      "sort.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(z_svc, "Z")',
        'Container(a_svc, "A")',
        'Container(m_svc, "M")',
        "@enduml",
      ].join("\n"),
    );
    expect(Object.keys(model.elements)).toEqual(["a_svc", "m_svc", "z_svc"]);
  });

  it("includes only declared containers in a boundary, not unrelated ones", async () => {
    const model = await loadFromContent(
      "boundary.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(outside, "Outside")',
        'System_Boundary(orders, "Orders") {',
        '  Container(orders_api, "Orders API")',
        "}",
        "@enduml",
      ].join("\n"),
    );
    const orders = model.boundaries.orders;
    expect(orders.elementNames).toEqual(["orders_api"]);
    expect(orders.elementNames).not.toContain("outside");
  });

  it("nests boundaries — child boundary names land under parent.boundaryNames", async () => {
    const model = await loadFromContent(
      "nested.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'System_Boundary(platform, "Platform") {',
        '  System_Boundary(orders, "Orders") {',
        '    Container(api, "API")',
        "  }",
        "}",
        "@enduml",
      ].join("\n"),
    );
    expect(model.boundaries.platform?.boundaryNames).toContain("orders");
  });

  it("does NOT push spurious self-relations for isolated containers (no Rel)", async () => {
    const model = await loadFromContent(
      "isolated.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(a, "A")',
        'Container(b, "B")',
        "@enduml",
      ].join("\n"),
    );
    for (const c of allElements(model)) {
      expect(c.relations).toEqual([]);
    }
  });

  it("dangling Rel() with unknown source/target surfaces via issues (no throw)", async () => {
    const file = await writeFixture(
      "missing.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(a, "A")',
        'Rel(a, ghost_to, "")',
        "@enduml",
      ].join("\n"),
    );
    const result = await load(file);
    expect(allElements(result.model)).toHaveLength(1);
    // The dangling target name appears in validation issues — loader survives.
    const dangling = result.issues.find((i) => i.kind === "dangling-relation");
    expect(dangling).toBeDefined();
  });
});

describe("PlantUML load — F2 fidelity (link, sprite, BiRel)", () => {
  let tmpDir: string;
  beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "aact-puml-f2-"));
  });

  const writeFixture = async (
    name: string,
    content: string,
  ): Promise<string> => {
    const file = path.join(tmpDir, name);
    await writeFile(file, content, "utf8");
    return file;
  };

  const loadFromContent = async (
    name: string,
    content: string,
  ): Promise<Model> => {
    const file = await writeFixture(name, content);
    const result = await load(file);
    return result.model;
  };

  it("preserves Container.link from $link= named arg", async () => {
    const model = await loadFromContent(
      "link.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(svc, "Svc", "Java", "Backend service", "img/svc.png", "core", "https://wiki.example.com/svc")',
        "@enduml",
      ].join("\n"),
    );
    expect(getElement(model, "svc")?.link).toBe("https://wiki.example.com/svc");
  });

  it("preserves Container.sprite from positional 5th arg", async () => {
    const model = await loadFromContent(
      "sprite.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(svc, "Svc", "Java", "Backend", "java-logo")',
        "@enduml",
      ].join("\n"),
    );
    // sprite present, tags empty → sprite preserved (not fallback'нут как tags)
    expect(getElement(model, "svc")?.sprite).toBe("java-logo");
    expect(getElement(model, "svc")?.tags).toEqual([]);
  });

  it("BiRel expands to two directed Rel — a→b AND b→a", async () => {
    // C4-PlantUML stdlib: BiRel(a, b, label) семантически = Rel(a,b) + Rel(b,a).
    // Loader должен expand'ить, чтобы downstream rules видели обе стороны графа.
    const model = await loadFromContent(
      "birel.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(svc_a, "A")',
        'Container(svc_b, "B")',
        'BiRel(svc_a, svc_b, "talks to")',
        "@enduml",
      ].join("\n"),
    );
    const a = getElement(model, "svc_a")!;
    const b = getElement(model, "svc_b")!;
    expect(a.relations).toHaveLength(1);
    expect(a.relations[0].to).toBe("svc_b");
    expect(b.relations).toHaveLength(1);
    expect(b.relations[0].to).toBe("svc_a");
    // Both relations carry the same attributes (label, technology, tags).
    expect(a.relations[0].description).toBe("talks to");
    expect(b.relations[0].description).toBe("talks to");
  });

  it.each(["BiRel_U", "BiRel_D", "BiRel_L", "BiRel_R", "BiRel_Neighbor"])(
    "%s directional variant also expands to two relations",
    async (macro) => {
      const model = await loadFromContent(
        `${macro.toLowerCase()}.puml`,
        [
          "@startuml",
          "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
          'Container(svc_a, "A")',
          'Container(svc_b, "B")',
          `${macro}(svc_a, svc_b, "x")`,
          "@enduml",
        ].join("\n"),
      );
      expect(getElement(model, "svc_a")?.relations[0].to).toBe("svc_b");
      expect(getElement(model, "svc_b")?.relations[0].to).toBe("svc_a");
    },
  );

  it("Rel (non-BiRel) stays unidirectional", async () => {
    const model = await loadFromContent(
      "rel-unidir.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(a, "A")',
        'Container(b, "B")',
        'Rel(a, b, "x")',
        "@enduml",
      ].join("\n"),
    );
    expect(getElement(model, "a")?.relations).toHaveLength(1);
    expect(getElement(model, "b")?.relations).toHaveLength(0);
  });

  it("Relation.link preserved from $link= named arg", async () => {
    const model = await loadFromContent(
      "rel-link.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(a, "A")',
        'Container(b, "B")',
        'Rel(a, b, "calls", "REST", "details", "spr", "tag1", "https://api.docs/v1")',
        "@enduml",
      ].join("\n"),
    );
    expect(getElement(model, "a")?.relations[0].link).toBe(
      "https://api.docs/v1",
    );
  });

  it("Boundary.link preserved from $link= positional", async () => {
    const model = await loadFromContent(
      "boundary-link.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'System_Boundary(orders, "Orders", "tag1", "https://wiki/orders") {',
        '  Container(api, "API")',
        "}",
        "@enduml",
      ].join("\n"),
    );
    expect(model.boundaries.orders?.link).toBe("https://wiki/orders");
  });
});

describe("PlantUML load — F2 known silent drops (plantuml-parser 0.4)", () => {
  let tmpDir: string;
  beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "aact-puml-drops-"));
  });

  const loadFromContent = async (
    name: string,
    content: string,
  ): Promise<Model> => {
    const file = path.join(tmpDir, name);
    await writeFile(file, content, "utf8");
    return (await load(file)).model;
  };

  /*
   * Below — explicit pin'ы для known limitations. Если plantuml-parser
   * получит native support (или мы добавим regex-scan), тесты упадут и
   * это станет триггером для миграции. CHANGELOG должен документировать
   * любое изменение поведения тут.
   */

  it("attaches PUML SetPropertyHeader/AddProperty rows to Container.properties", async () => {
    // Gap closed in v3.0.0-beta.18: `preParse.extractAttachedProperties`
    // walks the source for `AddProperty` lines and threads them through
    // to `toModel`, which attaches them to the next macro by 1-based
    // line number.
    const model = await loadFromContent(
      "props.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'SetPropertyHeader("Header", "Value")',
        'AddProperty("SLA", "99.9%")',
        'AddProperty("Owner", "team-x")',
        'Container(svc, "Svc")',
        "@enduml",
      ].join("\n"),
    );
    const svc = getElement(model, "svc");
    expect(svc).toBeDefined();
    expect(svc?.properties).toEqual({ SLA: "99.9%", Owner: "team-x" });
  });

  it("KNOWN GAP: Boundary description не expose'ится parser'ом — Boundary.description undefined", async () => {
    // plantuml-parser 0.4 принимает только 4 positional для Boundary
    // (alias, label, tags, link). Spec C4-PlantUML stdlib допускает 6
    // positional с descr, но parser падает с PEG syntax error на 5-ом arg.
    // Этот gap пинает текущее поведение — Boundary всегда без description.
    const model = await loadFromContent(
      "boundary-no-descr.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'System_Boundary(orders, "Orders") {',
        '  Container(api, "API")',
        "}",
        "@enduml",
      ].join("\n"),
    );
    expect(model.boundaries.orders).toBeDefined();
    expect(model.boundaries.orders?.description).toBeUndefined();
  });

  // ── plantuml-parser 0.4 adapter — gaps closed by pre-transform ──
  // (was "KNOWN GAP: $index=" — now fixed by the INDEX_MARKER pre-transform)

  it("$index= populates Relation.order — bare numeric form", async () => {
    const model = await loadFromContent(
      "indexed-bare.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(a, "A")',
        'Container(b, "B")',
        'Rel(a, b, "step 1", $index=1)',
        'Rel(b, a, "step 2", $index=2)',
        "@enduml",
      ].join("\n"),
    );
    // Without the pre-transform, $index= made plantuml-parser drop the entire
    // relation. Now both relations load AND carry their order.
    const a = getElement(model, "a")!;
    const b = getElement(model, "b")!;
    expect(a.relations).toHaveLength(1);
    expect(b.relations).toHaveLength(1);
    expect(a.relations[0]?.order).toBe(1);
    expect(b.relations[0]?.order).toBe(2);
  });

  it("$index= populates Relation.order — quoted form", async () => {
    const model = await loadFromContent(
      "indexed-quoted.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(a, "A")',
        'Container(b, "B")',
        'Rel(a, b, "step", "HTTP", $index="3")',
        "@enduml",
      ].join("\n"),
    );
    expect(getElement(model, "a")?.relations[0]?.order).toBe(3);
  });

  it("$index= with a non-numeric value degrades to undefined (no NaN)", async () => {
    const model = await loadFromContent(
      "indexed-bad.puml",
      [
        "@startuml",
        "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml",
        'Container(a, "A")',
        'Container(b, "B")',
        'Rel(a, b, "step", $index="oops")',
        "@enduml",
      ].join("\n"),
    );
    // Relation still loads; order is undefined rather than NaN.
    expect(getElement(model, "a")?.relations).toHaveLength(1);
    expect(getElement(model, "a")?.relations[0]?.order).toBeUndefined();
  });

  // Component_Boundary tests removed — it is NOT in the C4-PlantUML stdlib
  // (verified against upstream macro definitions, README, and c4model.com).
});

describe("PlantUML load — fixture-coverage edge", () => {
  it("loading generated.puml fixture doesn't throw", async () => {
    await expect(
      load("fixtures/architecture/generated.puml"),
    ).resolves.toBeDefined();
  });
});

describe("plantumlSyntax helpers", () => {
  it("containerDecl without tags omits the $tags attribute", () => {
    expect(
      plantumlSyntax.containerDecl({
        name: "orders",
        label: "Orders Service",
        kind: "Container",
        external: false,
        description: "",
        tags: [],
        relations: [],
      }),
    ).toBe('Container(orders, "Orders Service")');
  });

  it("containerDecl with tags emits $tags attribute", () => {
    expect(
      plantumlSyntax.containerDecl({
        name: "orders_acl",
        label: "Orders ACL",
        kind: "Container",
        external: false,
        description: "",
        tags: ["acl", "repo"],
        relations: [],
      }),
    ).toBe('Container(orders_acl, "Orders ACL", $tags="acl+repo")');
  });

  it("containerDecl retains all serializable element fields on replacement", () => {
    expect(
      plantumlSyntax.containerDecl({
        name: "orders_repo",
        label: "Orders repo",
        kind: "Container",
        external: false,
        description: "Persistence adapter",
        technology: "TypeScript",
        tags: ["repo"],
        sprite: "database",
        link: "https://example.test/repo",
        relations: [],
      }),
    ).toBe(
      'Container(orders_repo, "Orders repo", "TypeScript", "Persistence adapter", $sprite="database", $tags="repo", $link="https://example.test/repo")',
    );
  });

  it("relationDecl places description in PUML position 3 (label) and technology in position 4 (techn)", () => {
    // C4-PUML stdlib: Rel(from, to, label, techn, descr, sprite, tags, link).
    // Pin: rule fixes that pass `description` + `technology` end up in
    // the right slots and don't conflate them.
    expect(
      plantumlSyntax.relationDecl("a", "b", {
        description: "reads",
        technology: "PostgreSQL",
        tags: "async",
      }),
    ).toBe('Rel(a, b, "reads", "PostgreSQL", $tags="async")');
  });

  it("relationDecl tolerates missing opts and emits empty label", () => {
    expect(plantumlSyntax.relationDecl("a", "b")).toBe('Rel(a, b, "")');
  });

  it("relationDecl emits technology without a label when description is absent", () => {
    // PUML positional ordering — empty label slot stays "" so technology
    // lands in position 4.
    expect(plantumlSyntax.relationDecl("a", "b", { technology: "JDBC" })).toBe(
      'Rel(a, b, "", "JDBC")',
    );
  });

  it("relationDecl escapes URL technology so PlantUML does not treat // as italic markup", () => {
    expect(
      plantumlSyntax.relationDecl("a", "b", {
        technology: "https://gateway.int.com:443/goods/v1",
      }),
    ).toBe('Rel(a, b, "", "https:~//gateway.int.com:443/goods/v1")');
  });
});
