import { Section } from "../containers";

export interface DeployConfig {
  name: string;
  fileName?: string;
  readonly environment?: { [key: string]: object };
  sections: Section[];
}
