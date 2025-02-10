import { Container } from "./container";
import { Boundary } from "./boundary";

export interface PumlFile {
  readonly boundaries: Boundary[];
  readonly allContainers: Container[];
}
