import { chmodSync, readFileSync, writeFileSync } from "node:fs";

import { defineBuildConfig } from "unbuild";

export default defineBuildConfig({
  entries: ["src/index", "src/cli/index"],
  declaration: true,
  clean: true,
  externals: ["plantuml-parser", "yaml"],
  failOnWarn: true,
  hooks: {
    "build:done"(ctx) {
      const cli = ctx.options.outDir + "/cli/index.mjs";
      const content = readFileSync(cli, "utf8");
      writeFileSync(cli, "#!/usr/bin/env node\n" + content);
      // npm marks bins executable when it installs a tarball, but a clone
      // runs dist/ in place (`npx aact` inside the repo resolves to it), and
      // every build rewrites the file as 0644 — "Permission denied".
      chmodSync(cli, 0o755);
    },
  },
});
