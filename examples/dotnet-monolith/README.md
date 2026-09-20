# dotnet-monolith

A modular monolith has no network between modules — and no infrastructure
config describing how they talk. The dependency graph lives in the solution
instead, and there are **two different graphs** to read:

| Source                | Read from                       | Answers                                 | Misses                                                    |
| --------------------- | ------------------------------- | --------------------------------------- | --------------------------------------------------------- |
| **ProjectReference**  | `*.csproj`, no build required   | what a project _declares_ it depends on | whether the dependency is used at all                     |
| **AssemblyReference** | compiled `*.dll`, after a build | what survived compilation and is used   | a declared reference nobody calls (the compiler drops it) |

Both are converted to the same aact Model, so the same rules, `check` and
`diff` work on either. Neither sees reflection or DI registrations.

## Layout

```
architecture.puml        # intended architecture: one container, three components
architecture.tags.json   # project name → tags (bc:orders, bc:inventory)
aact.config.ts           # source + bcIsolation configured with apiSuffix "_contracts"
solution/                # tiny .NET solution used as the subject
tools/csproj-to-aact.mjs        # source 1 — ProjectReference graph
tools/assembly-to-aact/         # source 2 — AssemblyReference graph
```

## The intended architecture

One deployable, three projects, two modules. `Orders` may use the Inventory
contract; `Inventory.Internal` belongs to the Inventory module alone:

```
orders             → inventory_contracts
inventory_internal → inventory_contracts
```

## The solution as built (drift)

`solution/Orders` deliberately references `Inventory.Internal` and news up
`InventoryService` directly, so both adapters report the same violation.

### Source 1 — declared graph, no build

```bash
node tools/csproj-to-aact.mjs solution as-built.aact.json \
  --boundary "Reservation Monolith" --tags architecture.tags.json

npx aact check as-built.aact.json          # bcIsolation: orders crosses into inventory_internal
npx aact diff architecture.puml as-built.aact.json   # +1 relation [structural]
```

### Source 2 — compiled graph, after a build

```bash
dotnet build solution/Orders/Orders.csproj
dotnet run --project tools/assembly-to-aact -- \
  solution/Orders/bin/Debug/net8.0 compiled.aact.json \
  --boundary "Reservation Monolith" --tags architecture.tags.json

npx aact diff as-built.aact.json compiled.aact.json  # where the two sources disagree
```

## The .NET nuance — visible in this example

Run both adapters and compare. The declared graph has three edges; the
compiled one has two:

```
.csproj     orders → inventory_contracts, orders → inventory_internal
assemblies  orders → inventory_internal
```

`OrderService` news up `InventoryService` directly and never touches
`IInventory`, so the compiler drops the unused `Inventory.Contracts`
reference. Reference a project but never use a type from it, and the
reference will not appear in the compiled assembly — the same caveat the
[ModularMonolith sample](../../ModularMonolith/Readme.md) calls out for
assembly-based tests. That is exactly why the two sources answer different
questions:

- **`.csproj`** — the review question: did we _declare_ a dependency the
  architecture forbids? Runs on a clean checkout, catches the reference the
  moment it lands in a PR.
- **assemblies** — the runtime question: does the code _actually_ pull that
  module in? Needs a build, ignores dead references.

Pick per rule. A layering gate usually wants the declared graph; a "this
module must not be reachable" guarantee wants the compiled one.

## Mapping names is a project decision

`architecture.tags.json` is explicit on purpose: only the team knows which
projects form one module. The adapters do not guess — they read the map, or
emit untagged components.
