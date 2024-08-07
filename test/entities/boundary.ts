import { Container } from "./container";


export interface Boundary {
  readonly name: string;
  readonly label: string;
  readonly type?: string;
  boundaries: Boundary[];
  readonly containers: Container[];
}

