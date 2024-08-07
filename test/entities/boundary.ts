import { Container } from "./container";


export interface Boundary {
  readonly name: string;
  readonly label: string;
  readonly type?: string;
  readonly tags?: string;
  boundaries: Boundary[];
  readonly containers: Container[];
}

