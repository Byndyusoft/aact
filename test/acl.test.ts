import { Container } from "../src/entities";
import {
  loadPlantumlElements,
  mapContainersFromPlantumlElements,
} from "../src/plantuml";

const SystemExternalType = "System_Ext";

describe("Architecture", () => {
  let containersFromPuml: Container[];

  beforeAll(async () => {
    const pumlElements = await loadPlantumlElements("C4L2.puml");
    containersFromPuml =
      mapContainersFromPlantumlElements(pumlElements).allContainers;
  });

  it("only acl can depend on external systems", () => {
    for (const container of containersFromPuml) {
      const externalRelations = container.relations.filter(
        (r) => r.to.type === SystemExternalType,
      );
      if (!container.tags?.includes("acl") && externalRelations.length > 0)
        throw new Error('Assertion failed');
    }
  });
});
