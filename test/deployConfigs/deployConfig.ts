import { Section } from "../containers";

export interface DeployConfig {
  name: string;
  readonly environment?: { [key: string]: object };
  sections: Section[];
}
