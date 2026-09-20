import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";

import { computeDiff } from "../../src/diff";
import { load as loadModelJson } from "../../src/formats/model-json/load";
import { load as loadPlantuml } from "../../src/formats/plantuml/load";
import type { Model } from "../../src/model";
import { bcIsolationRule } from "../custom-rules/rules/bcIsolation";

const DIR = "examples/dotnet-monolith";
const ARCH = `${DIR}/architecture.puml`;
const ADAPTER = `${DIR}/tools/csproj-to-aact.mjs`;
const BC_OPTIONS = { apiSuffix: "_contracts" } as const;

describe("dotnet-monolith — intended modules vs the .csproj graph", () => {
  let intended: Model;
  let asBuilt: Model;
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "aact-dotnet-monolith-"));
    const output = join(workDir, "as-built.aact.json");

    await execa("node", [
      ADAPTER,
      `${DIR}/solution`,
      output,
      "--boundary",
      "Reservation Monolith",
      "--tags",
      `${DIR}/architecture.tags.json`,
    ]);

    intended = (await loadPlantuml(ARCH)).model;
    asBuilt = (await loadModelJson(output)).model;
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("the adapter names components exactly like the diagram", () => {
    expect(Object.keys(asBuilt.elements).sort()).toEqual(
      Object.keys(intended.elements).sort(),
    );
  });

  it("every edge is tagged with the source it came from", () => {
    const technologies = Object.values(asBuilt.elements).flatMap((element) =>
      element.relations.map((relation) => relation.technology),
    );
    expect(new Set(technologies)).toEqual(new Set(["ProjectReference"]));
  });

  it("the intended architecture keeps modules behind their contracts", () => {
    expect(bcIsolationRule.check(intended, BC_OPTIONS)).toHaveLength(0);
  });

  it("the solution reaches into Inventory.Internal — bcIsolation catches it", () => {
    const violations = bcIsolationRule.check(asBuilt, BC_OPTIONS);
    expect(violations.map((violation) => violation.target)).toEqual(["orders"]);
  });

  it("diff reports the extra reference as one structural change", () => {
    const changes = computeDiff(
      intended,
      asBuilt,
      { source: ARCH, format: "plantuml" },
      { source: "as-built.aact.json", format: "model-json" },
    ).changes;

    const structural = changes.filter(
      (change) => change.severity === "structural",
    );
    expect(structural).toHaveLength(1);
    expect(structural[0]).toMatchObject({
      entity: "relation",
      action: "added",
      from: "orders",
      to: "inventory_internal",
    });
  });
});
