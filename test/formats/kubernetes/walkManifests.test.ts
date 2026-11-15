import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { walkManifests } from "../../../src/formats/kubernetes/walkManifests";

const make = async (prefix = "aact-k8s-walk-"): Promise<string> =>
  mkdtemp(join(tmpdir(), prefix));

describe("walkManifests — entry resolution", () => {
  it("parses a single file as multi-doc YAML", async () => {
    const dir = await make();
    const file = join(dir, "deployment.yaml");
    await writeFile(
      file,
      [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        "  name: orders",
        "spec: {}",
        "---",
        "apiVersion: v1",
        "kind: Service",
        "metadata:",
        "  name: orders",
        "spec: {}",
      ].join("\n"),
    );
    const { manifests, issues } = await walkManifests(file);
    expect(manifests).toHaveLength(2);
    expect(manifests[0].kind).toBe("Deployment");
    expect(manifests[1].kind).toBe("Service");
    expect(manifests[0].docIndex).toBe(0);
    expect(manifests[1].docIndex).toBe(1);
    expect(issues).toEqual([]);
  });

  it("walks directories recursively for *.yaml and *.yml", async () => {
    const dir = await make();
    await writeFile(
      join(dir, "deploy.yaml"),
      "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: a }\nspec: {}",
    );
    const sub = join(dir, "sub");
    await mkdir(sub);
    await writeFile(
      join(sub, "stateful.yml"),
      "apiVersion: apps/v1\nkind: StatefulSet\nmetadata: { name: b }\nspec: {}",
    );
    const { manifests } = await walkManifests(dir);
    expect(manifests.map((m) => m.kind).toSorted()).toEqual([
      "Deployment",
      "StatefulSet",
    ]);
  });

  it("ignores hidden directories", async () => {
    const dir = await make();
    const hidden = join(dir, ".git");
    await mkdir(hidden);
    await writeFile(
      join(hidden, "secret.yaml"),
      "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: x }",
    );
    await writeFile(
      join(dir, "real.yaml"),
      "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: real }",
    );
    const { manifests } = await walkManifests(dir);
    expect(manifests.map((m) => m.metadata.name)).toEqual(["real"]);
  });

  it("skips non-YAML extensions", async () => {
    const dir = await make();
    await writeFile(join(dir, "README.md"), "# notes");
    await writeFile(join(dir, "values.json"), "{}");
    await writeFile(
      join(dir, "app.yaml"),
      "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: app }",
    );
    const { manifests } = await walkManifests(dir);
    expect(manifests).toHaveLength(1);
  });

  it("chases kustomization.yaml resources field", async () => {
    const dir = await make();
    await writeFile(
      join(dir, "kustomization.yaml"),
      "resources:\n  - deploy.yaml",
    );
    await writeFile(
      join(dir, "deploy.yaml"),
      "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: app }",
    );
    const { manifests, issues } = await walkManifests(dir);
    expect(manifests.map((m) => m.metadata.name)).toEqual(["app"]);
    // No advanced features used → no issues
    expect(issues).toEqual([]);
  });

  it("throws on Helm template marker", async () => {
    const dir = await make();
    const file = join(dir, "tpl.yaml");
    await writeFile(
      file,
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ .Release.Name }}",
    );
    await expect(walkManifests(file)).rejects.toThrow(/Helm template/);
  });

  it("emits loader-warning for malformed manifest doc (missing metadata.name)", async () => {
    const dir = await make();
    const file = join(dir, "bad.yaml");
    await writeFile(file, "apiVersion: apps/v1\nkind: Deployment\nspec: {}");
    const { manifests, issues } = await walkManifests(file);
    expect(manifests).toEqual([]);
    expect(issues[0]).toMatchObject({
      kind: "loader-warning",
      code: "missing-kind-or-name",
    });
  });

  it("propagates ENOENT for missing entry path", async () => {
    await expect(walkManifests("/nonexistent/bogus/path.yaml")).rejects.toThrow(
      /ENOENT/,
    );
  });

  it("skips empty YAML docs (--- with nothing)", async () => {
    const dir = await make();
    const file = join(dir, "empty.yaml");
    await writeFile(
      file,
      "---\napiVersion: apps/v1\nkind: Deployment\nmetadata: { name: a }\n---\n",
    );
    const { manifests } = await walkManifests(file);
    expect(manifests).toHaveLength(1);
  });

  it("emits kustomize-resource-missing when resources entry doesn't exist", async () => {
    const dir = await make();
    await writeFile(
      join(dir, "kustomization.yaml"),
      "resources:\n  - ./missing.yaml",
    );
    const { manifests, issues } = await walkManifests(dir);
    expect(manifests).toEqual([]);
    expect(
      issues.some(
        (i) =>
          i.kind === "loader-warning" &&
          i.code === "kustomize-resource-missing",
      ),
    ).toBe(true);
  });

  it("kustomization.yaml entry-point (file directly, not dir)", async () => {
    const dir = await make();
    const kustomization = join(dir, "kustomization.yaml");
    await writeFile(kustomization, "resources:\n  - deploy.yaml");
    await writeFile(
      join(dir, "deploy.yaml"),
      "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: app }",
    );
    const { manifests } = await walkManifests(kustomization);
    expect(manifests.map((m) => m.metadata.name)).toEqual(["app"]);
  });

  it("avoids cycles via visited set when kustomization references same file twice", async () => {
    const dir = await make();
    await writeFile(
      join(dir, "kustomization.yaml"),
      "resources:\n  - deploy.yaml\n  - deploy.yaml",
    );
    await writeFile(
      join(dir, "deploy.yaml"),
      "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: app }",
    );
    const { manifests } = await walkManifests(dir);
    expect(manifests).toHaveLength(1);
  });

  it("extracts metadata.namespace + labels + annotations", async () => {
    const dir = await make();
    await writeFile(
      join(dir, "x.yaml"),
      [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        "  name: orders",
        "  namespace: shop",
        "  labels:",
        "    app: orders",
        "    tier: backend",
        "  annotations:",
        "    aact.kind: ContainerDb",
        "    aact.label: Orders",
      ].join("\n"),
    );
    const { manifests } = await walkManifests(dir);
    expect(manifests[0].metadata.namespace).toBe("shop");
    expect(manifests[0].metadata.labels.app).toBe("orders");
    expect(manifests[0].metadata.annotations["aact.kind"]).toBe("ContainerDb");
  });
});

describe("walkManifests — source locations", () => {
  // Regression: ParsedManifest.sourceLocation was declared but never set,
  // so `aact check ./k8s/` printed violations with no file:line anchor.
  it("points each manifest at its metadata.name, also in later documents", async () => {
    const dir = await make();
    const file = join(dir, "orders.yaml");
    await writeFile(
      file,
      [
        "apiVersion: apps/v1", // 1
        "kind: Deployment", // 2
        "metadata:", // 3
        "  name: orders", // 4
        "spec: {}", // 5
        "---", // 6
        "apiVersion: v1", // 7
        "kind: Service", // 8
        "metadata:", // 9
        "  namespace: shop", // 10
        "  name: orders-svc", // 11
        "spec: {}",
      ].join("\n"),
    );
    const { manifests } = await walkManifests(file);

    expect(manifests[0].sourceLocation).toMatchObject({
      file,
      start: { line: 4, col: 9 },
    });
    expect(manifests[1].sourceLocation).toMatchObject({
      file,
      start: { line: 11, col: 9 },
    });
  });

  it("falls back to the document start when metadata.name is not a plain scalar", async () => {
    const dir = await make();
    const file = join(dir, "anchor.yaml");
    await writeFile(
      file,
      [
        "apiVersion: apps/v1", // 1 — document start
        "kind: Deployment",
        "metadata:",
        "  labels: { app: &n orders }",
        "  name: *n", // an alias node, not a scalar
        "spec: {}",
      ].join("\n"),
    );
    const { manifests } = await walkManifests(file);
    expect(manifests[0].metadata.name).toBe("orders");
    expect(manifests[0].sourceLocation?.start.line).toBe(1);
  });
});
