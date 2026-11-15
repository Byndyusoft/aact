import { computeDiff } from "../../src/diff";
import { makeModel } from "../helpers/makeModel";

const SIDE = { source: "x", format: "plantuml" } as const;

describe("computeDiff — duplicate identical relations (P1.3)", () => {
  it("does not collapse two identical relations from baseline when only one survives", () => {
    // Both baseline relations are the same (from, to, technology) —
    // the Map<id, relation> approach silently dropped one and the
    // diff reported a false "no change" or worse, a description
    // change. Multiset matching pairs them by index: first ↔ first,
    // second → removed.
    const a = makeModel({
      elements: [
        {
          name: "api",
          relations: [
            { to: "db", technology: "HTTP" },
            { to: "db", technology: "HTTP" },
          ],
        },
        { name: "db" },
      ],
    });
    const b = makeModel({
      elements: [
        { name: "api", relations: [{ to: "db", technology: "HTTP" }] },
        { name: "db" },
      ],
    });
    const result = computeDiff(a, b, SIDE, SIDE);
    const relChanges = result.changes.filter((c) => c.entity === "relation");
    // One relation removed, none modified, none added.
    expect(relChanges.filter((c) => c.action === "removed")).toHaveLength(1);
    expect(relChanges.filter((c) => c.action === "modified")).toHaveLength(0);
    expect(relChanges.filter((c) => c.action === "added")).toHaveLength(0);
  });

  it("matches both duplicate relations when both sides have them", () => {
    const a = makeModel({
      elements: [
        {
          name: "api",
          relations: [
            { to: "db", technology: "HTTP" },
            { to: "db", technology: "HTTP" },
          ],
        },
        { name: "db" },
      ],
    });
    const b = a;
    const result = computeDiff(a, b, SIDE, SIDE);
    expect(result.changes).toHaveLength(0);
  });
});

describe("computeDiff — rename-aware relation matching (P2.4)", () => {
  it("does not emit relation removed/added pairs when only the source element was renamed", () => {
    const a = makeModel({
      elements: [
        {
          name: "user_service",
          label: "Users",
          relations: [{ to: "db" }],
        },
        { name: "db" },
      ],
    });
    const b = makeModel({
      elements: [
        { name: "users", label: "Users", relations: [{ to: "db" }] },
        { name: "db" },
      ],
    });
    const result = computeDiff(a, b, SIDE, SIDE);
    // Should see ONE rename change for the element. No relation diff —
    // the edge to `db` carries over via the rename map.
    expect(result.changes.filter((c) => c.entity === "element")).toHaveLength(
      1,
    );
    expect(result.changes.filter((c) => c.entity === "relation")).toHaveLength(
      0,
    );
  });

  it("does not emit relation diff when only the target was renamed", () => {
    const a = makeModel({
      elements: [
        { name: "api", relations: [{ to: "user_db" }] },
        { name: "user_db", label: "User Store" },
      ],
    });
    const b = makeModel({
      elements: [
        { name: "api", relations: [{ to: "users_db" }] },
        { name: "users_db", label: "User Store" },
      ],
    });
    const result = computeDiff(a, b, SIDE, SIDE);
    expect(result.changes.filter((c) => c.entity === "relation")).toHaveLength(
      0,
    );
  });

  it("still emits a real relation change after rename when technology truly changes", () => {
    const a = makeModel({
      elements: [
        {
          name: "user_service",
          label: "Users",
          relations: [{ to: "db", technology: "Postgres" }],
        },
        { name: "db" },
      ],
    });
    const b = makeModel({
      elements: [
        {
          name: "users",
          label: "Users",
          relations: [{ to: "db", technology: "CockroachDB" }],
        },
        { name: "db" },
      ],
    });
    const result = computeDiff(a, b, SIDE, SIDE);
    const relChange = result.changes.find((c) => c.entity === "relation");
    expect(relChange?.action).toBe("modified");
    expect(relChange?.fields).toContainEqual(
      expect.objectContaining({ field: "technology" }),
    );
  });
});

describe("computeDiff — relation properties (P2.5)", () => {
  it("detects properties bag change on a relation as semantic field", () => {
    const a = makeModel({
      elements: [
        {
          name: "a",
          relations: [{ to: "b", technology: "HTTP", properties: { v: "1" } }],
        },
        { name: "b" },
      ],
    });
    const b = makeModel({
      elements: [
        {
          name: "a",
          relations: [{ to: "b", technology: "HTTP", properties: { v: "2" } }],
        },
        { name: "b" },
      ],
    });
    const result = computeDiff(a, b, SIDE, SIDE);
    const relChange = result.changes.find((c) => c.entity === "relation");
    expect(relChange?.fields).toContainEqual(
      expect.objectContaining({ field: "properties" }),
    );
    expect(relChange?.severity).toBe("semantic");
  });
});

describe("computeDiff — absent vs empty optional text", () => {
  // Regression: PlantUML `Rel(a, b, "")` loads with no description while a
  // model-json produced by an external adapter carries `""`. The strict
  // comparison reported one phantom cosmetic change per such relation
  // (seen on examples/dotnet-monolith: "+ 2 cosmetic changes").
  it("treats an undefined and an empty relation description as equal", () => {
    const a = makeModel({
      elements: [
        { name: "orders", relations: [{ to: "inventory", technology: "Ref" }] },
        { name: "inventory" },
      ],
    });
    const b = makeModel({
      elements: [
        {
          name: "orders",
          relations: [{ to: "inventory", technology: "Ref", description: "" }],
        },
        { name: "inventory" },
      ],
    });

    expect(computeDiff(a, b, SIDE, SIDE).changes).toHaveLength(0);
  });

  it("treats an undefined and an empty boundary description as equal", () => {
    const a = makeModel({
      elements: [{ name: "orders" }],
      boundaries: [{ name: "mono", elementNames: ["orders"] }],
    });
    const b = makeModel({
      elements: [{ name: "orders" }],
      boundaries: [{ name: "mono", elementNames: ["orders"], description: "" }],
    });

    expect(computeDiff(a, b, SIDE, SIDE).changes).toHaveLength(0);
  });

  it("still reports a real description change", () => {
    const a = makeModel({
      elements: [
        { name: "orders", relations: [{ to: "inventory", technology: "Ref" }] },
        { name: "inventory" },
      ],
    });
    const b = makeModel({
      elements: [
        {
          name: "orders",
          relations: [
            { to: "inventory", technology: "Ref", description: "reserves" },
          ],
        },
        { name: "inventory" },
      ],
    });

    expect(computeDiff(a, b, SIDE, SIDE).changes).toEqual([
      expect.objectContaining({
        entity: "relation",
        action: "modified",
        severity: "cosmetic",
      }),
    ]);
  });
});
