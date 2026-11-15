# Custom rules example

Two project-specific rules running alongside `aact`'s built-ins:

| Rule              | What it enforces                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `bcIsolation`     | Cross-bounded-context calls must route through a `*_api` container or a `broker`-tagged broker. |
| `requireOwnerTag` | Every operational container must carry an `owner:<team>` tag.                                   |

## Try it

```bash
# From the example folder:
cd examples/custom-rules
npx aact check
```

Expected output: two violations — both from the custom rules. The config
opts into the built-ins `acl` and `acyclic` (no violations there); built-ins
are off unless named, so `crud` stays quiet.

- `bcIsolation` fires on `orders_svc → inventory_svc` (direct cross-BC call,
  bypasses `inventory_api`).
- `requireOwnerTag` fires on `inventory_svc` (no `owner:*` tag).

## Layout

```
custom-rules/
├── aact.config.ts                # defineConfig + customRules + rule options
├── architecture.puml             # PlantUML source with intentional violations
├── rules/
│   ├── bcIsolation.ts            # rule #1 (typed options, no fix)
│   └── requireOwnerTag.ts        # rule #2 (typed options, no fix)
└── custom-rules.test.ts          # programmatic tests for both rules
```

## Anatomy of a custom rule

A rule is a single `RuleDefinition` object. The `defineRule` helper
preserves the literal `name` so `defineConfig` can wire it into the typed
`rules{}` shape for autocomplete.

```ts
import { defineRule, type Model } from "aact";

export interface MyOptions {
  readonly threshold?: number;
}

export const myRule = defineRule({
  name: "myRule",
  description: "Short, user-facing summary of the check",

  check(model: Model, options?: MyOptions) {
    const threshold = options?.threshold ?? 0;
    return Object.values(model.containers)
      .filter(/* condition */)
      .map((c) => ({
        container: c.name,
        message: "explanation of the violation",
      }));
  },
});
```

### Optional `fix()`

`check` is required; `fix` is optional. When you implement `fix`, `aact
check --fix` will offer auto-correction for violations of your rule. See
the built-in `src/rules/acl.ts` for a worked example — it injects a new
ACL container and rewires the violating relations through it.

### Conflict policy

A custom rule whose `name` matches a built-in or another custom rule is
rejected at startup. Prefix rule names per project (for example,
`acmeBcIsolation`) to keep them unique across plugins.

## Registering

`aact.config.ts` registers the rules and configures their options:

```ts
import { defineConfig } from "aact";
import { myRule } from "./rules/myRule";

export default defineConfig({
  source: "./architecture.puml",

  customRules: [myRule], // auto-enabled

  rules: {
    acl: true,
    myRule: { threshold: 3 }, // configured exactly like built-ins
  },
});
```

`defineConfig` is generic over `customRules`. TypeScript autocompletes the
rule's `name` as a valid key in `rules{}` and infers the option shape from
the rule's `check` signature — typing
`rules: { myRule: { ←tab } }` suggests `threshold`.

## When to write a custom rule

Reach for one when:

- The check is **project-specific** — naming conventions, internal
  compliance, bounded-context discipline, ownership tagging — and would
  not make sense to ship with `aact` itself.
- A built-in covers the right _idea_ but enforces it in a way that does
  not match your conventions, and configuring its options is not enough.
- You need a check that closes a real recurring review comment, not a
  hypothetical one.

Avoid one when:

- A built-in already covers it with different options — configure the
  built-in instead.
- The check is one-off and unlikely to recur — a PR template comment is
  cheaper than a rule.
