import { Container } from "./container";
import { Boundary } from "./Boundary";


export interface PumlFile {
  readonly boundaries: Boundary[];
  readonly allContainers: Container[];
}
