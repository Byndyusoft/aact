import { defineConfig } from "../../src";
import { bcIsolationRule } from "../custom-rules/rules/bcIsolation";

/**
 * A modular monolith is one deployable, so its modules are C4 *components*
 * inside a single container — not containers of their own.
 *
 * The public entry point of a module here is its contract assembly
 * (`Inventory.Contracts`), so `bcIsolation` is configured with
 * `apiSuffix: "_contracts"`: cross-module references must land on the
 * contract, never on an implementation project.
 */
export default defineConfig({
  source: "./architecture.puml",

  customRules: [bcIsolationRule],

  rules: {
    acyclic: true,
    bcIsolation: {
      bcTagPrefix: "bc:",
      apiSuffix: "_contracts",
    },
  },
});
