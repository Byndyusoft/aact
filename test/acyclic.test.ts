import { Container } from "../src/entities";
import { Relation } from "../src/entities/relation";
import {
  loadPlantumlElements,
  mapContainersFromPlantumlElements,
} from "../src/plantuml";

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
        if (rel.to.name == sourceContainerName) 
          throw new Error('Assertion failed');
        findCycle(rel.to.relations, sourceContainerName);
      }
    }
  });
});
