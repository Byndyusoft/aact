import { Container } from "./container";

export interface Relation {
  readonly to: Container;
  readonly technology?: string;
  readonly tags?: string[];
}
