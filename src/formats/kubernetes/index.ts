import * as v from "valibot";

import { imageHeuristicSchema } from "../_shared/optionsSchema";
import type { Format } from "../types";
import { generate } from "./generate";
import { load } from "./load";

/** Mirrors `KubernetesLoadOptions` (types.ts) — keep in sync. */
export const kubernetesLoadOptionsSchema = v.strictObject({
  annotations: v.optional(
    v.strictObject({
      prefix: v.optional(v.string()),
    }),
  ),
  namespaces: v.optional(v.array(v.string())),
  skip: v.optional(v.array(v.string())),
  imageHeuristic: v.optional(imageHeuristicSchema),
});

/**
 * Kubernetes Format — `load` + `generate`.
 *
 * Phase 2 (current): `load` поддерживает workload kinds → C4
 * Container, namespace → Boundary, `aact.*` annotation conventions
 * для round-trip metadata. Helm templates rejected с понятной
 * ошибкой (Phase 3); kustomize.resources chase — Phase C of
 * Phase 2 ADR (next commit).
 *
 * `generate` существует с v3.0 — Model → per-Container Deployment-style
 * YAML файлы (приближение для review). См. `generate.ts`.
 *
 * `fix` намеренно отсутствует — IaC не authored руками, и k8s
 * manifests не имеют meaningful range-edit semantics для C4 правил.
 *
 * `defaultPattern` опущен потому что у k8s нет канонического имени
 * файла (`deployment.yaml`, `service.yaml`, `app.yaml` — любое).
 * Пользователь явно указывает `source.type: "kubernetes"` или
 * `--baseline-format kubernetes` в CLI.
 *
 * Out of scope (Phase 2): NetworkPolicy / Ingress / Gateway API /
 * NetworkPolicy / ConfigMap-ref edges / Helm rendering / kustomize
 * patches / CRDs (Crossplane / ArgoCD).
 */
export const kubernetesFormat: Format = {
  name: "kubernetes",
  loadOptionsSchema: kubernetesLoadOptionsSchema,
  load,
  generate,
};
