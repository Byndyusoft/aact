import { Container } from "./entities";
import { Relation } from "./entities/relation";
import {
  loadPlantumlElements,
  mapContainersFromPlantumlElements,
} from "./plantuml";

describe("Architecture", () => {
  let containersFromPuml: Container[];

  beforeAll(async () => {
    const pumlElements = await loadPlantumlElements("C4L2.puml");
    containersFromPuml =
      mapContainersFromPlantumlElements(pumlElements).allContainers;
  });

  it("no cycles in rels", () => {
    for (const container of containersFromPuml) {
      findCycle(container.relations, container.name);
    }

    function findCycle(rels: Relation[], sourceContainerName: string) {
      for (const rel of rels) {
        if (rel.to.name == sourceContainerName) fail();
        findCycle(rel.to.relations, sourceContainerName);
      }
    }
  });
});
