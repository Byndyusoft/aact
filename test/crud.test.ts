import { Container } from "../src/entities";
import {
  loadPlantumlElements,
  mapContainersFromPlantumlElements,
} from "../src/plantuml";

const ContainerDb = "ContainerDb";

describe("Architecture", () => {
  let containersFromPuml: Container[];

  beforeAll(async () => {
    const pumlElements = await loadPlantumlElements("C4L2.puml");
    containersFromPuml =
      mapContainersFromPlantumlElements(pumlElements).allContainers;
  });

  it("only crud can relate to DB", () => {
    for (const container of containersFromPuml) {
      const dbRelation = container.relations.filter(
        (r) => r.to.type === ContainerDb,
      );
      if (
        !container.tags?.includes("repo") &&
        !container.tags?.includes("relay") &&
        dbRelation.length > 0
      )
        throw new Error('Assertion failed');
        
      if (
        container.tags?.includes("repo") &&
        container.relations.some((r) => r.to.type != ContainerDb)
      )
        throw new Error('Assertion failed');
    }
  });
});
