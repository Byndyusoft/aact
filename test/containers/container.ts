import { Relation } from "./relation";

export interface Container {
  readonly name: string;
  readonly label: string;
  readonly type?: string;
  readonly tags?: string;
  readonly description: string;
  readonly relations: Relation[];
}
