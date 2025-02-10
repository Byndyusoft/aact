import { Section } from "../entities";

export interface DeployConfig {
  name: string;
  fileName?: string;
  readonly environment?: { [key: string]: object };
  sections: Section[];
}
