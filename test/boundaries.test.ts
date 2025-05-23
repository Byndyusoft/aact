/* eslint-disable no-console */

import { Boundary, PumlFile } from "../src/entities";

import {
  loadPlantumlElements,
  mapContainersFromPlantumlElements,
} from "../src/plantuml";

const SystemExternalType = "System_Ext";
const ContainerType = "Container";

describe("Architecture", () => {
  let pumlFile: PumlFile;

  beforeAll(async () => {
    const pumlElements = await loadPlantumlElements("boundaries.puml");
    pumlFile = mapContainersFromPlantumlElements(pumlElements);
  });

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, n/global-require
    global.console = require("console");
  });

  afterEach(() => {
    global.console = console;
  });

  it("check coupling and cohesion", () => {
    // для всех наших контекстов и периметров
    for (const boundary of pumlFile.boundaries) {
      const cohesion = GetBoundaryCohesion(boundary);
      const coupling = GetBoundaryCoupling(boundary);

      console.log(
        boundary.label + " — Cohesion: " + cohesion + "; Coupling: " + coupling,
      );
      // во-первых, внутренняя прочность периметра должна быть больше внешней связанности
      expect(cohesion).toBeGreaterThan(coupling);

      // во-вторых, если у периметр содержит в себе другие периметры — его прочность должна быть меньше суммы прочностей внутренних периметров
      if (boundary.boundaries.length > 0)
        expect(cohesion).toBeLessThan(
          boundary.boundaries.reduce(
            (sum: number, current: Boundary) =>
              sum + GetBoundaryCohesion(current),
            0,
          ),
        );
    }
  });
});

function GetBoundaryCohesion(boundary: Boundary) {
  var result = 0;
  for (const container of boundary.containers) {
    result += container.relations.filter((r) =>
      boundary.containers.some((c) => c.name == r.to.name),
    ).length;
  }
  for (const innerBoundary of boundary.boundaries) {
    result += GetBoundaryCoupling(innerBoundary);
  }
  return result;
}

function GetBoundaryCoupling(boundary: Boundary) {
  var result = 0;

  for (const container of boundary.containers) {
    result += container.relations.filter(
      (r) =>
        r.to.type == ContainerType &&
        !boundary.containers.some((c) => c.name == r.to.name),
    ).length;
  }

  for (const innerBoundary of boundary.boundaries) {
    for (const container of innerBoundary.containers) {
      result += container.relations.filter(
        (r) => r.to.type == SystemExternalType,
      ).length;
    }
  }

  return result;
}
