import { Container } from "./entities";
import {
  loadPlantumlElements,
  mapContainersFromPlantumlElements,
} from "./plantuml";

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
      if (!container.tags?.includes("repo") && dbRelation.length > 0) fail();

      if (
        container.tags?.includes("repo") &&
        container.relations.some((r) => r.to.type != ContainerDb)
      )
        fail();
    }
  });
});
