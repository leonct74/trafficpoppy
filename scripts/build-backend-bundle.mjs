#!/usr/bin/env node
/**
 * Produce the artifacts the sidecar needs to deploy WITHOUT cdk at the user's runtime,
 * and embed them in a generated TS module the sidecar imports:
 *
 *   infra/src/template.ts  ──esbuild──▶ evaluate ──▶ backend/src/generated/backend-bundle.ts
 *
 * (MailPoppy's proven backend-bundle pattern; at P1 this script also bundles the collector
 * Lambda into a deterministic zip and embeds it alongside the template.)
 *
 * `templateKey` is content-addressed — a hash of the template bytes — so the sidecar can
 * tell "the stack already runs exactly this" from "the app shipped a new template", and
 * so `NO_CHANGE` can be cross-checked against what's actually deployed rather than
 * trusted (DESIGN.md §8).
 *
 * ⚠️  STALE-SIDECAR TRAP (CLAUDE.md gotcha #1): the sidecar EMBEDS this output. After any
 *     change to infra/ you must rebuild the sidecar and fully restart AgentsPoppy, or the
 *     deploy silently reports NO_CHANGE with the old template. `npm run build:sidecar`
 *     runs this first (prebuild:sidecar) so the two can't drift.
 *
 * Run from the repo root:  npm run gen:backend
 */
import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { deterministicZip } from "./lib/deterministic-zip.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const genDir = join(root, "backend", "src", "generated");

const staging2 = () => join(tmpdir(), `tp-lambda-${process.pid}`);

const git = (args) => {
  try {
    return execFileSync("git", args, { cwd: root }).toString().trim();
  } catch {
    return "";
  }
};

async function main() {
  // 1. Bundle + evaluate the template builder. (It's TypeScript, and it's the single
  //    source of truth for the stack — we never hand-maintain a parallel JSON copy.)
  console.log("[1/3] evaluate infra/src/template.ts");
  const staging = join(tmpdir(), `tp-infra-${process.pid}`);
  mkdirSync(staging, { recursive: true });
  const outfile = join(staging, "template.mjs");
  await esbuild.build({
    entryPoints: [join(root, "infra", "src", "template.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "warning",
  });
  const { buildTemplate, STACK_NAME, TABLE_NAME } = await import(pathToFileURL(outfile).href);
  rmSync(staging, { recursive: true, force: true });

  // Stable key order + 2-space indent: the template builder is pure, so these bytes (and
  // therefore templateKey) are identical on every machine at the same commit.
  const templateJson = JSON.stringify(buildTemplate(), null, 2);
  const templateKey = `template-${createHash("sha256").update(templateJson).digest("hex").slice(0, 16)}`;

  // 2. Bundle the collector Lambda into ONE CJS file, then a deterministic zip. The AWS SDK
  //    is provided by the nodejs20.x runtime, so we mark it external — keeps the zip tiny
  //    and avoids shipping a second copy of the SDK.
  console.log("[2/3] esbuild + zip the collector Lambda");
  const lambdaOut = join(staging2(), "collector.js");
  mkdirSync(dirname(lambdaOut), { recursive: true });
  await esbuild.build({
    entryPoints: [join(root, "lambdas", "src", "collector.ts")],
    outfile: lambdaOut,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    minify: true, // reproducibility: strips module-boundary comments that encode install paths
    legalComments: "none",
    external: ["@aws-sdk/*"],
    logLevel: "warning",
  });
  const lambdaJs = readFileSync(lambdaOut);
  rmSync(dirname(lambdaOut), { recursive: true, force: true });
  // Content-addressed key so an unchanged collector reuses the same S3 object and
  // CloudFormation sees NO_CHANGE — while any code change flips the key and forces an update.
  const lambdaCodeKey = `collector-${createHash("sha256").update(lambdaJs).digest("hex").slice(0, 16)}.zip`;
  // Fixed mtime (HEAD commit time) → byte-identical archive on any machine at the same commit.
  const epoch = Number(process.env.SOURCE_DATE_EPOCH || git(["log", "-1", "--format=%ct"]) || 0);
  const lambdaZip = deterministicZip([{ name: "collector.js", data: lambdaJs }], epoch);
  const lambdaZipBase64 = lambdaZip.toString("base64");

  // 2b. A minimal probe function (diagnostics): same shape as a hand-made hello-world,
  //     but deployable through the broker to bisect WHAT about the collector trips the
  //     public-URL 403. Tiny, tag-free, deleted after use.
  const probeJs = Buffer.from(
    'exports.handler=async()=>({statusCode:200,headers:{"content-type":"text/plain"},body:"TrafficPoppy probe OK"});',
  );
  const probeZipBase64 = deterministicZip([{ name: "probe.js", data: probeJs }], epoch).toString("base64");

  // 3. Emit the module the sidecar imports. Git-ignored: it is a build output, and
  //    committing it would let it drift from infra/ + lambdas/.
  console.log("[3/3] generate backend/src/generated/backend-bundle.ts");
  mkdirSync(genDir, { recursive: true });
  writeFileSync(
    join(genDir, "backend-bundle.ts"),
    [
      "// AUTO-GENERATED by scripts/build-backend-bundle.mjs — do not edit (git-ignored).",
      "// Rebuild with `npm run gen:backend` after ANY change under infra/ or lambdas/.",
      `export const stackName = ${JSON.stringify(STACK_NAME)};`,
      `export const tableName = ${JSON.stringify(TABLE_NAME)};`,
      `export const templateKey = ${JSON.stringify(templateKey)};`,
      `export const templateJson = ${JSON.stringify(templateJson)};`,
      `export const lambdaCodeKey = ${JSON.stringify(lambdaCodeKey)};`,
      `export const lambdaZipBase64 = ${JSON.stringify(lambdaZipBase64)};`,
      `export const probeZipBase64 = ${JSON.stringify(probeZipBase64)};`,
      `export const sourceCommit = ${JSON.stringify(git(["rev-parse", "HEAD"]))};`,
      "",
    ].join("\n"),
  );

  console.log(
    `\n✅ backend bundle ready (${templateKey}, template ${(templateJson.length / 1024).toFixed(1)} KB; ` +
      `${lambdaCodeKey}, zip ${(lambdaZip.length / 1024).toFixed(0)} KB)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
