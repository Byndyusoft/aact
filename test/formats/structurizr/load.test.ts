import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import path from "pathe";

import { load } from "../../../src/formats/structurizr/load";
import { structurizrDslSyntax } from "../../../src/formats/structurizr/syntax";
import type { LoadResult } from "../../../src/formats/types";
import type { Model } from "../../../src/model";
import { allElements, getElement } from "../../../src/model";

let tmpDir: string;
beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "aact-struct-"));
});

let counter = 0;
const loadWorkspaceResult = async (workspace: unknown): Promise<LoadResult> => {
  const file = path.join(tmpDir, `workspace-${counter++}.json`);
  await writeFile(file, JSON.stringify(workspace), "utf8");
  return load(file);
};
const loadWorkspace = async (workspace: unknown): Promise<Model> =>
  (await loadWorkspaceResult(workspace)).model;

describe("structurizr load — fixture", () => {
  let model: Model;

  beforeAll(async () => {
    const result = await load("fixtures/architecture/workspace.json");
    model = result.model;
  });

  it("loads containers from workspace.json", () => {
    expect(allElements(model).length).toBeGreaterThan(0);
  });

  it("identifies external systems (kind=System + external=true)", () => {
    const externalSystems = allElements(model).filter(
      (c) => c.kind === "System" && c.external,
    );
    expect(externalSystems.length).toBeGreaterThan(0);
  });

  it("identifies databases", () => {
    const databases = allElements(model).filter(
      (c) => c.kind === "ContainerDb",
    );
    expect(databases.length).toBeGreaterThan(0);
  });

  it("loads boundaries", () => {
    expect(Object.values(model.boundaries).length).toBeGreaterThan(0);
  });

  it("builds relations", () => {
    const relationsCount = allElements(model).reduce(
      (sum, c) => sum + c.relations.length,
      0,
    );
    expect(relationsCount).toBeGreaterThan(0);
  });

  it("rejects with ENOENT for nonexistent file", async () => {
    await expect(load("nonexistent.json")).rejects.toThrow(/ENOENT/);
  });
});

describe("structurizr load — DSL identifier", () => {
  it("returns empty model for empty workspace", async () => {
    const model = await loadWorkspace({
      model: { softwareSystems: [], people: [] },
    });
    expect(allElements(model)).toHaveLength(0);
    expect(Object.values(model.boundaries)).toHaveLength(0);
  });

  it("uses structurizr.dsl.identifier as the container name when present", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            properties: { "structurizr.dsl.identifier": "my_system" },
            containers: [
              {
                id: "2",
                name: "Svc",
                properties: { "structurizr.dsl.identifier": "my_svc" },
                relationships: [],
              },
            ],
          },
        ],
        people: [],
      },
    });
    expect(model.boundaries.my_system).toBeDefined();
    expect(model.boundaries.my_system?.elementNames).toContain("my_svc");
    expect(model.boundaries.my_system?.properties).toBeUndefined();
    expect(model.elements.my_svc?.properties).toBeUndefined();
  });

  it("falls back to raw id when no DSL identifier property is set", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          { id: "sys_raw", name: "Sys", containers: [], relationships: [] },
        ],
        people: [],
      },
    });
    expect(getElement(model, "sys_raw")).toBeDefined();
  });

  it("model.elements Record is sorted alphabetically", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            containers: [
              { id: "z", name: "Z", relationships: [] },
              { id: "a", name: "A", relationships: [] },
              { id: "m", name: "M", relationships: [] },
            ],
          },
        ],
        people: [],
      },
    });
    expect(Object.keys(model.elements)).toEqual(["a", "m", "z"]);
  });
});

describe("structurizr load — kind inference from technology", () => {
  const dbContainer = (technology: string, name = "svc") => ({
    model: {
      softwareSystems: [
        {
          id: "1",
          name: "Sys",
          containers: [{ id: "c", name, technology, relationships: [] }],
        },
      ],
      people: [],
    },
  });

  for (const tech of ["PostgreSQL", "MySQL", "Redis", "MongoDB"]) {
    it(`marks ${tech}-tech container as ContainerDb`, async () => {
      const model = await loadWorkspace(dbContainer(tech));
      expect(getElement(model, "c")?.kind).toBe("ContainerDb");
    });
  }

  it("marks container with name ending in '_db' as ContainerDb", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            containers: [{ id: "c", name: "orders_db", relationships: [] }],
          },
        ],
        people: [],
      },
    });
    // Container.name = dslId(id) = "c"; label = "orders_db".
    // inferKindFromTechnology checks label/name suffix.
    expect(getElement(model, "c")?.kind).toBe("ContainerDb");
  });

  it("marks container with name ending in 'database' as ContainerDb", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "c",
            name: "1",
            containers: [
              { id: "x", name: "orders database", relationships: [] },
            ],
          },
        ],
        people: [],
      },
    });
    expect(getElement(model, "x")?.kind).toBe("ContainerDb");
  });

  it("does NOT mark unrelated container as ContainerDb", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            containers: [
              {
                id: "c",
                name: "orders_api",
                technology: "Spring",
                relationships: [],
              },
            ],
          },
        ],
        people: [],
      },
    });
    expect(getElement(model, "c")?.kind).toBe("Container");
  });
});

describe("structurizr load — tags parsing", () => {
  const containerWith = (name: string, tags?: string) => ({
    model: {
      softwareSystems: [
        {
          id: "1",
          name: "Sys",
          containers: [{ id: "c", name, tags, relationships: [] }],
        },
      ],
      people: [],
    },
  });

  it("preserves explicit comma-separated tags trimmed", async () => {
    const model = await loadWorkspace(
      containerWith("svc", "tag1, tag2 , tag3"),
    );
    expect(getElement(model, "c")?.tags).toEqual(["tag1", "tag2", "tag3"]);
  });

  it("filters out empty tags from the source list", async () => {
    const model = await loadWorkspace(containerWith("svc", "a,,b,"));
    expect(getElement(model, "c")?.tags).toEqual(["a", "b"]);
  });

  it("v3 NO LONGER enriches tags from names (crud→repo, acl→acl)", async () => {
    // v2 had enrichTagsFromNames heuristic — Solution Architects now tag
    // explicitly. Container with label "orders_crud_service" must NOT get
    // an auto-tag "repo".
    const model = await loadWorkspace(containerWith("orders_crud_service"));
    expect(getElement(model, "c")?.tags).toEqual([]);
  });
});

describe("structurizr load — relations", () => {
  it("preserves technology when explicitly set", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            containers: [
              {
                id: "a",
                name: "A",
                relationships: [
                  {
                    destinationId: "b",
                    technology: "REST",
                    description: "calls",
                  },
                ],
              },
              { id: "b", name: "B", relationships: [] },
            ],
          },
        ],
        people: [],
      },
    });
    expect(getElement(model, "a")?.relations[0].technology).toBe("REST");
  });

  it("appends 'async' tag when interactionStyle is Asynchronous", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            containers: [
              {
                id: "a",
                name: "A",
                relationships: [
                  {
                    destinationId: "b",
                    tags: "audit",
                    interactionStyle: "Asynchronous",
                  },
                ],
              },
              { id: "b", name: "B", relationships: [] },
            ],
          },
        ],
        people: [],
      },
    });
    expect(getElement(model, "a")?.relations[0].tags).toEqual([
      "audit",
      "async",
    ]);
  });

  it("does NOT append 'async' when interactionStyle is Synchronous", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            containers: [
              {
                id: "a",
                name: "A",
                relationships: [
                  { destinationId: "b", interactionStyle: "Synchronous" },
                ],
              },
              { id: "b", name: "B", relationships: [] },
            ],
          },
        ],
        people: [],
      },
    });
    expect(getElement(model, "a")?.relations[0].tags).not.toContain("async");
  });

  it("dangling destinationId surfaces in issues (no throw)", async () => {
    const file = path.join(tmpDir, "dangling.json");
    await writeFile(
      file,
      JSON.stringify({
        model: {
          softwareSystems: [
            {
              id: "1",
              name: "Sys",
              containers: [
                {
                  id: "a",
                  name: "A",
                  relationships: [{ destinationId: "ghost" }],
                },
              ],
            },
          ],
          people: [],
        },
      }),
      "utf8",
    );
    const result = await load(file);
    expect(allElements(result.model)).toHaveLength(1);
  });

  it("skips linked Structurizr JSON relationships as derived duplicates", async () => {
    const file = path.join(tmpDir, "linked-relations.json");
    await writeFile(
      file,
      JSON.stringify({
        model: {
          softwareSystems: [
            {
              id: "sys_a",
              name: "System A",
              properties: { "structurizr.dsl.identifier": "sys_a" },
              containers: [
                {
                  id: "a",
                  name: "A",
                  relationships: [
                    {
                      id: "r1",
                      sourceId: "a",
                      destinationId: "b",
                      description: "HTTP",
                    },
                    {
                      id: "r2",
                      sourceId: "a",
                      destinationId: "sys_b",
                      linkedRelationshipId: "r1",
                      description: "HTTP",
                    },
                  ],
                },
              ],
            },
            {
              id: "sys_b",
              name: "System B",
              properties: { "structurizr.dsl.identifier": "sys_b" },
              containers: [{ id: "b", name: "B", relationships: [] }],
            },
          ],
          people: [],
        },
      }),
      "utf8",
    );

    const result = await load(file);
    expect(result.issues).toHaveLength(0);
    expect(getElement(result.model, "a")?.relations).toMatchObject([
      { to: "b", description: "HTTP" },
    ]);
  });

  it("trims whitespace from relation tags", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            containers: [
              {
                id: "a",
                name: "A",
                relationships: [
                  { destinationId: "b", tags: "  audit , urgent  " },
                ],
              },
              { id: "b", name: "B", relationships: [] },
            ],
          },
        ],
        people: [],
      },
    });
    expect(getElement(model, "a")?.relations[0].tags).toEqual([
      "audit",
      "urgent",
    ]);
  });
});

describe("structurizr load — external systems", () => {
  it("treats `location: External` as kind=System + external=true", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "ext",
            name: "External",
            location: "External",
            containers: [],
          },
        ],
        people: [],
      },
    });
    const ext = getElement(model, "ext");
    expect(ext?.kind).toBe("System");
    expect(ext?.external).toBe(true);
  });

  it("detects external system by tags containing 'External'", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          { id: "ext", name: "External", tags: "External", containers: [] },
        ],
        people: [],
      },
    });
    expect(getElement(model, "ext")?.external).toBe(true);
  });

  it("treats `external` / `External System` tags as external without config", async () => {
    for (const tags of ["external", "External System"]) {
      const model = await loadWorkspace({
        model: {
          softwareSystems: [
            { id: "ext", name: "Vendor", tags, containers: [] },
          ],
          people: [],
        },
      });
      expect(getElement(model, "ext")?.external).toBe(true);
    }
  });

  it("external system tags parse from comma-separated string", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "ext",
            name: "External",
            location: "External",
            tags: "Critical, Vendor , ",
            containers: [],
          },
        ],
        people: [],
      },
    });
    expect(getElement(model, "ext")?.tags).toEqual(["Critical", "Vendor"]);
  });

  it("external system description falls back to empty string", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          { id: "ext", name: "Ext", location: "External", containers: [] },
        ],
        people: [],
      },
    });
    expect(getElement(model, "ext")?.description).toBe("");
  });
});

describe("structurizr load — defaults & resilience", () => {
  it("description falls back to empty string when not provided", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            containers: [{ id: "c", name: "svc", relationships: [] }],
          },
        ],
        people: [],
      },
    });
    expect(getElement(model, "c")?.description).toBe("");
  });

  it("loads container components as component-level elements", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            containers: [
              {
                id: "a",
                name: "A",
                components: [
                  {
                    id: "comp",
                    name: "Comp",
                    technology: "PostgreSQL",
                    relationships: [{ destinationId: "b" }],
                  },
                ],
                relationships: [],
              },
              { id: "b", name: "B", relationships: [] },
            ],
          },
        ],
        people: [],
      },
    });

    expect(model.boundaries[1]?.boundaryNames).toContain("a");
    expect(model.boundaries.a?.elementNames).toEqual(["comp"]);
    expect(getElement(model, "comp")?.kind).toBe("ComponentDb");
    expect(getElement(model, "comp")?.relations[0].to).toBe("b");
  });

  it("handles a system with undefined containers", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [{ id: "sys1", name: "Sys" }],
        people: [],
      },
    });
    expect(getElement(model, "sys1")?.kind).toBe("System");
    expect(model.boundaries.sys1).toBeUndefined();
  });

  it("handles workspace with no `people` field", async () => {
    const model = await loadWorkspace({
      model: { softwareSystems: [] },
    });
    expect(allElements(model)).toHaveLength(0);
  });

  it("handles workspace with no `softwareSystems` field", async () => {
    const model = await loadWorkspace({ model: { people: [] } });
    expect(allElements(model)).toHaveLength(0);
    expect(Object.values(model.boundaries)).toHaveLength(0);
  });
});

describe("structurizr load — people", () => {
  it("filters out empty tags from a person's tag string", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [],
        people: [
          {
            id: "p1",
            name: "User",
            tags: "vip,,admin,",
            relationships: [],
          },
        ],
      },
    });
    expect(getElement(model, "p1")?.tags).toEqual(["vip", "admin"]);
  });

  it("processes people as kind=Person", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [],
        people: [
          {
            id: "p1",
            name: "Operator",
            description: "Ops user",
            tags: "internal,admin",
            relationships: [],
          },
        ],
      },
    });
    const person = getElement(model, "p1");
    expect(person?.kind).toBe("Person");
    expect(person?.description).toBe("Ops user");
    expect(person?.tags).toEqual(["internal", "admin"]);
  });

  it("registers person → container relationship", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            containers: [{ id: "svc", name: "Svc", relationships: [] }],
          },
        ],
        people: [
          {
            id: "user",
            name: "User",
            relationships: [{ destinationId: "svc" }],
          },
        ],
      },
    });
    // Relation target = dslId of destinationId = "svc" (raw id, no DSL property).
    expect(getElement(model, "user")?.relations[0].to).toBe("svc");
  });
});

describe("structurizr load — properties forwarding", () => {
  it("preserves arbitrary string properties on container", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            containers: [
              {
                id: "c",
                name: "Svc",
                properties: { archetype: "Microservice", owner: "team-a" },
                relationships: [],
              },
            ],
          },
        ],
        people: [],
      },
    });
    expect(getElement(model, "c")?.properties).toEqual({
      archetype: "Microservice",
      owner: "team-a",
    });
  });

  it("filters out non-string property values (toProperties typeof check)", async () => {
    // Pin the `typeof entry[1] === "string"` filter — non-string values
    // (numbers, nested objects from LikeC4) must NOT leak through.
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            containers: [
              {
                id: "c",
                name: "Svc",
                properties: {
                  good: "value",
                  numeric: 42, // runtime filter drops non-strings
                  nested: { key: "val" }, // same
                },
                relationships: [],
              },
            ],
          },
        ],
        people: [],
      },
    });
    expect(getElement(model, "c")?.properties).toEqual({ good: "value" });
  });

  it("filters out generated structurizr.dsl.identifier from properties", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            containers: [
              {
                id: "c",
                name: "Svc",
                properties: {
                  "structurizr.dsl.identifier": "svc",
                  owner: "team-a",
                },
                relationships: [],
              },
            ],
          },
        ],
        people: [],
      },
    });
    expect(getElement(model, "svc")?.properties).toEqual({ owner: "team-a" });
  });

  it("returns undefined for container with no properties", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            containers: [{ id: "c", name: "Svc", relationships: [] }],
          },
        ],
        people: [],
      },
    });
    expect(getElement(model, "c")?.properties).toBeUndefined();
  });

  it("returns undefined when all properties filtered out (entries.length===0)", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            containers: [
              {
                id: "c",
                name: "Svc",
                properties: {
                  bad: 42, // non-string, gets filtered → entries empty
                },
                relationships: [],
              },
            ],
          },
        ],
        people: [],
      },
    });
    expect(getElement(model, "c")?.properties).toBeUndefined();
  });
});

describe("structurizr load — relation field preservation", () => {
  it("preserves rel.description as relation.description", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            containers: [
              {
                id: "a",
                name: "A",
                relationships: [
                  {
                    destinationId: "b",
                    description: "calls",
                    technology: "REST",
                  },
                ],
              },
              { id: "b", name: "B", relationships: [] },
            ],
          },
        ],
        people: [],
      },
    });
    expect(getElement(model, "a")?.relations[0].description).toBe("calls");
  });

  it("description=undefined when not provided in rel", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            containers: [
              {
                id: "a",
                name: "A",
                relationships: [{ destinationId: "b" }],
              },
              { id: "b", name: "B", relationships: [] },
            ],
          },
        ],
        people: [],
      },
    });
    expect(getElement(model, "a")?.relations[0].description).toBeUndefined();
  });
});

describe("structurizr load — boundary metadata", () => {
  it("preserves boundary tags from system tags", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            tags: "domain, public",
            containers: [{ id: "api", name: "API", relationships: [] }],
          },
        ],
        people: [],
      },
    });
    expect(model.boundaries[1]?.tags).toEqual(["domain", "public"]);
  });

  it("preserves internal leaf SoftwareSystem relationships", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "sys_a",
            name: "Sys A",
            relationships: [{ destinationId: "sys_b" }],
            containers: [],
          },
          {
            id: "sys_b",
            name: "Sys B",
            containers: [],
          },
        ],
        people: [],
      },
    });
    expect(getElement(model, "sys_a")?.kind).toBe("System");
    expect(getElement(model, "sys_a")?.relations[0].to).toBe("sys_b");
  });

  it("warns when a decomposed SoftwareSystem relationship cannot be represented", async () => {
    const result = await loadWorkspaceResult({
      model: {
        softwareSystems: [
          {
            id: "sys_a",
            name: "Sys A",
            relationships: [{ destinationId: "sys_b" }],
            containers: [{ id: "api", name: "API", relationships: [] }],
          },
          {
            id: "sys_b",
            name: "Sys B",
            containers: [{ id: "worker", name: "Worker", relationships: [] }],
          },
        ],
        people: [],
      },
    });

    expect(result.issues).toContainEqual(
      expect.objectContaining({
        kind: "loader-warning",
        source: "structurizr",
        code: "boundary-source-relationship-not-represented",
        element: "sys_a",
      }),
    );
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ kind: "dangling-relation" }),
    );
  });

  it("multiple internal SoftwareSystems each become a root boundary", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "alpha",
            name: "Alpha",
            containers: [{ id: "a1", name: "A1", relationships: [] }],
          },
          {
            id: "beta",
            name: "Beta",
            containers: [{ id: "b1", name: "B1", relationships: [] }],
          },
        ],
        people: [],
      },
    });
    expect(model.rootBoundaryNames).toContain("alpha");
    expect(model.rootBoundaryNames).toContain("beta");
  });
});

describe("structurizr load — F2 fidelity (url, group, perspectives)", () => {
  it("Container.url → Container.link", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            containers: [
              {
                id: "c",
                name: "Svc",
                url: "https://wiki.example.com/svc",
                relationships: [],
              },
            ],
          },
        ],
        people: [],
      },
    });
    expect(getElement(model, "c")?.link).toBe("https://wiki.example.com/svc");
  });

  it("Person.url → Person.link", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [],
        people: [
          {
            id: "u",
            name: "User",
            url: "https://hr.example.com/u",
            relationships: [],
          },
        ],
      },
    });
    expect(getElement(model, "u")?.link).toBe("https://hr.example.com/u");
  });

  it("Decomposed internal SoftwareSystem.url → Boundary.link", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "sys",
            name: "Sys",
            url: "https://wiki.example.com/sys",
            containers: [{ id: "api", name: "API", relationships: [] }],
          },
        ],
        people: [],
      },
    });
    expect(model.boundaries.sys?.link).toBe("https://wiki.example.com/sys");
  });

  it("External SoftwareSystem.url → Container.link", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "ext",
            name: "Ext",
            location: "External",
            url: "https://api.external.com",
            containers: [],
          },
        ],
        people: [],
      },
    });
    expect(getElement(model, "ext")?.link).toBe("https://api.external.com");
  });

  it("Relation.url → Relation.link", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            containers: [
              {
                id: "a",
                name: "A",
                relationships: [
                  {
                    destinationId: "b",
                    url: "https://api.example.com/v1",
                  },
                ],
              },
              { id: "b", name: "B", relationships: [] },
            ],
          },
        ],
        people: [],
      },
    });
    expect(getElement(model, "a")?.relations[0].link).toBe(
      "https://api.example.com/v1",
    );
  });

  it("Container.group → Container.properties.group", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            containers: [
              {
                id: "c",
                name: "Svc",
                group: "platform-team",
                relationships: [],
              },
            ],
          },
        ],
        people: [],
      },
    });
    expect(getElement(model, "c")?.properties).toMatchObject({
      group: "platform-team",
    });
  });

  it("Container.perspectives → properties.perspective.<name>", async () => {
    // Solution Architect use case — security/scalability views на одной модели.
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            containers: [
              {
                id: "c",
                name: "Svc",
                perspectives: {
                  Security: {
                    description: "Sensitive PII data",
                    value: "high",
                  },
                  Performance: { description: "Read-heavy workload" },
                },
                relationships: [],
              },
            ],
          },
        ],
        people: [],
      },
    });
    expect(getElement(model, "c")?.properties).toMatchObject({
      "perspective.Security": "Sensitive PII data",
      "perspective.Security.value": "high",
      "perspective.Performance": "Read-heavy workload",
    });
  });

  it("Relation.properties → Relation.properties (full pass-through)", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            containers: [
              {
                id: "a",
                name: "A",
                relationships: [
                  {
                    destinationId: "b",
                    properties: {
                      sla: "99.9",
                      protocol: "https",
                    },
                  },
                ],
              },
              { id: "b", name: "B", relationships: [] },
            ],
          },
        ],
        people: [],
      },
    });
    expect(getElement(model, "a")?.relations[0].properties).toMatchObject({
      sla: "99.9",
      protocol: "https",
    });
  });

  it("Relation.perspectives → Relation.properties.perspective.<name>", async () => {
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            containers: [
              {
                id: "a",
                name: "A",
                relationships: [
                  {
                    destinationId: "b",
                    perspectives: {
                      Security: { description: "Uses TLS 1.3" },
                    },
                  },
                ],
              },
              { id: "b", name: "B", relationships: [] },
            ],
          },
        ],
        people: [],
      },
    });
    expect(getElement(model, "a")?.relations[0].properties).toMatchObject({
      "perspective.Security": "Uses TLS 1.3",
    });
  });
});

describe("structurizrDslSyntax helpers", () => {
  it("containerDecl without tags emits a single-line declaration", () => {
    expect(
      structurizrDslSyntax.containerDecl({
        name: "orders",
        label: "Orders Service",
        kind: "Container",
        external: false,
        description: "",
        tags: [],
        relations: [],
      }),
    ).toBe('orders = container "Orders Service"');
  });

  it("containerDecl with tags emits a block with tags clause", () => {
    expect(
      structurizrDslSyntax.containerDecl({
        name: "orders_acl",
        label: "Orders ACL",
        kind: "Container",
        external: false,
        description: "",
        tags: ["acl"],
        relations: [],
      }),
    ).toBe('orders_acl = container "Orders ACL" {\n    tags "acl"\n}');
  });

  it("containerDecl retains description, technology, link, and properties", () => {
    expect(
      structurizrDslSyntax.containerDecl({
        name: "orders_repo",
        label: "Orders repo",
        kind: "Container",
        external: false,
        description: "Persistence adapter",
        technology: "TypeScript",
        tags: ["repo"],
        link: "https://example.test/repo",
        properties: { owner: "orders" },
        relations: [],
      }),
    ).toContain('description "Persistence adapter"');
  });

  it("relationDecl emits description and technology in DSL slots", () => {
    expect(
      structurizrDslSyntax.relationDecl("a", "b", {
        description: "reads",
        technology: "REST",
      }),
    ).toBe('a -> b "reads" "REST"');
  });

  it("relationDecl with tags appends a tags block", () => {
    expect(
      structurizrDslSyntax.relationDecl("a", "b", {
        description: "reads",
        technology: "REST",
        tags: "async",
      }),
    ).toBe('a -> b "reads" "REST" {\n    tags "async"\n}');
  });

  it("relationDecl tolerates missing opts and emits a bare arrow", () => {
    expect(structurizrDslSyntax.relationDecl("a", "b")).toBe("a -> b");
  });

  it("relationDecl emits an empty description placeholder when only technology is set", () => {
    // Structurizr DSL is positional — technology can't be specified
    // without a (possibly empty) description in front of it.
    expect(
      structurizrDslSyntax.relationDecl("a", "b", { technology: "REST" }),
    ).toBe('a -> b "" "REST"');
  });
});

describe("structurizr load — component kind inference", () => {
  it("infers ComponentQueue from a queue technology on a component", async () => {
    // componentKindFromTechnology maps an inferred ContainerQueue to
    // ComponentQueue (load.ts:133-134) when the parent is a container
    // boundary (i.e. the system holds containers that hold components).
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            containers: [
              {
                id: "a",
                name: "A",
                components: [
                  {
                    id: "queue_comp",
                    name: "Event Bus",
                    technology: "Kafka",
                    relationships: [],
                  },
                ],
                relationships: [],
              },
            ],
          },
        ],
        people: [],
      },
    });
    expect(getElement(model, "queue_comp")?.kind).toBe("ComponentQueue");
  });

  it("defaults a component with a plain technology to kind Component", async () => {
    // Neither DB nor queue technology, and the name does not trigger
    // the name-based heuristic — componentKindFromTechnology falls
    // through to the plain Component default (load.ts:134).
    const model = await loadWorkspace({
      model: {
        softwareSystems: [
          {
            id: "1",
            name: "Sys",
            containers: [
              {
                id: "a",
                name: "A",
                components: [
                  {
                    id: "plain_comp",
                    name: "Router",
                    technology: "Java",
                    relationships: [],
                  },
                ],
                relationships: [],
              },
            ],
          },
        ],
        people: [],
      },
    });
    expect(getElement(model, "plain_comp")?.kind).toBe("Component");
  });
});

describe("structurizr load — boundary-target relationship", () => {
  it("warns and drops a Container relationship whose target maps to a Boundary", async () => {
    // sys_a is decomposed (→ Boundary) and its container `api` points
    // at sys_b, which is also decomposed (→ Boundary). The source `api`
    // is a real Container, but the target sys_b is a Boundary, so the
    // edge can't be represented: load.ts:454-461 warns + continues.
    const result = await loadWorkspaceResult({
      model: {
        softwareSystems: [
          {
            id: "sys_a",
            name: "Sys A",
            containers: [
              {
                id: "api",
                name: "API",
                relationships: [{ destinationId: "sys_b" }],
              },
            ],
          },
          {
            id: "sys_b",
            name: "Sys B",
            containers: [{ id: "worker", name: "Worker", relationships: [] }],
          },
        ],
        people: [],
      },
    });

    expect(result.issues).toContainEqual(
      expect.objectContaining({
        kind: "loader-warning",
        source: "structurizr",
        code: "boundary-target-relationship-not-represented",
        element: "api",
      }),
    );
    // The dropped relationship must NOT survive on the source element.
    expect(getElement(result.model, "api")?.relations).toEqual([]);
  });
});
