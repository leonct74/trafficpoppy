#!/usr/bin/env node
// Bundle the TrafficPoppy backend into the single CJS file AgentsPoppy's SHARED Node
// runtime executes (extension.json `backend.runtime: "node22"` — agentspoppy
// docs/RUNTIMES.md, rule R1). This replaces the SEA pipeline (build-sidecar.mjs): the
// package ships only the poppy's own code and NO embedded Node, so it is a fraction of
// the size, and ONE platform-neutral package serves every OS — which also retires the
// darwin/win32 cross-build machinery.
//
// What still rides inside the bundle is the poppy's OWN code: the CloudFormation
// template and the collector Lambda zip, embedded by scripts/build-backend-bundle.mjs
// into src/generated/backend-bundle.ts (run first — see `prebuild:backend`). R1 forbids
// third-party runtimes and service binaries, not your own deployable artifacts.
//
// ⚠️ The stale-build trap survives the change (CLAUDE.md gotcha #1): this bundle EMBEDS
//    the generated template + Lambda zip, so after any infra/ or lambdas/ change you must
//    rebuild AND fully restart AgentsPoppy, or deploys report NO_CHANGE against old code.
import * as esbuild from "esbuild";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outfile = join(root, "backend", "index.cjs");

await esbuild.build({
  entryPoints: [join(root, "backend", "src", "server.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile,
  logLevel: "warning",
});
console.log(`✅ backend bundle → ${outfile} (${(statSync(outfile).size / 1024 / 1024).toFixed(1)} MB)`);
