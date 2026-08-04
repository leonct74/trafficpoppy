import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildEdgeTemplate, EDGE_REGION, EDGE_STACK_NAME, TP_HOST_HEADER } from "./edge-template";

const template = buildEdgeTemplate();
const R = template.Resources as Record<string, { Type: string; Properties: any; DeletionPolicy?: string }>;
const dist = R.Distribution!.Properties.DistributionConfig;
const behavior = dist.DefaultCacheBehavior;

/** Resolve a { "Fn::If": ["HasViewer", a, b] } node to one branch, like CloudFormation would. */
const resolveIf = (node: any, hasViewer: boolean) => (node?.["Fn::If"] ? node["Fn::If"][hasViewer ? 1 : 2] : node);
/** The default behavior's forwarded header list for a given HasViewer outcome. */
const defaultHeaders = (hasViewer: boolean): string[] =>
  resolveIf(behavior.ForwardedValues.Headers, hasViewer);

describe("the True Reach edge stack (ACM + CloudFront, us-east-1)", () => {
  it("pins the one region CloudFront accepts certificates from", () => {
    expect(EDGE_REGION).toBe("us-east-1");
    expect(EDGE_STACK_NAME).toMatch(/^TrafficPoppy/); // covered by the cloudformation grant scope
  });

  it("takes the certificate as a PARAMETER — the sidecar requests it, born tagged (I3)", () => {
    // CloudTrail-proven: CloudFormation's ACM handler calls RequestCertificate without
    // tags, which the broker's birth-tag rule rightly denies. So no Certificate resource
    // here — the sidecar requests it with the attribution tags and passes the ARN in.
    expect(R.Certificate).toBeUndefined();
    expect((template.Parameters as Record<string, unknown>).CertificateArn).toBeDefined();
    expect(dist.ViewerCertificate.AcmCertificateArn).toEqual({ Ref: "CertificateArn" });
  });

  it("forwards the geo header + opt-out signals, and NEVER the Host header", () => {
    for (const hasViewer of [true, false]) {
      const headers = defaultHeaders(hasViewer);
      expect(headers).toContain("cloudfront-viewer-country"); // the whole point of the tier
      expect(headers).toContain("sec-gpc"); // GPC/DNT must survive the edge — privacy invariant
      expect(headers).toContain("dnt");
      // A Function URL routes by its own hostname; forwarding the viewer Host would 403 at origin.
      expect(headers.map((h) => h.toLowerCase())).not.toContain("host");
    }
    // The collection paths' own behaviors must carry the same beacon headers.
    for (const b of resolveIf(dist.CacheBehaviors, true)) {
      expect(b.ForwardedValues.Headers).toContain("cloudfront-viewer-country");
      expect(b.ForwardedValues.Headers).toContain("sec-gpc");
    }
  });

  it("carries the public hostname to the collector via the static origin header", () => {
    for (const hasViewer of [true, false]) {
      const origin = resolveIf(dist.Origins, hasViewer).find((o: any) => o.Id === "collector");
      expect(origin.OriginCustomHeaders).toEqual([
        { HeaderName: TP_HOST_HEADER, HeaderValue: { Ref: "DomainName" } },
      ]);
      expect(origin.CustomOriginConfig.OriginProtocolPolicy).toBe("https-only");
    }
  });

  it("never caches (collector is dynamic) and never forwards cookies (we never read them)", () => {
    expect(behavior.MinTTL).toBe(0);
    expect(behavior.DefaultTTL).toBe(0);
    expect(behavior.MaxTTL).toBe(0);
    expect(behavior.ForwardedValues.Cookies).toEqual({ Forward: "none" });
  });

  it("accepts POST (the beacon) and serves only over HTTPS", () => {
    expect(behavior.AllowedMethods).toContain("POST");
    expect(behavior.ViewerProtocolPolicy).toBe("redirect-to-https");
    expect(dist.ViewerCertificate.MinimumProtocolVersion).toMatch(/^TLSv1\.2/);
  });

  it("avoids untaggable resource types — tagged-as-self grants must reach everything mutable", () => {
    // CloudFront OriginRequestPolicy / CachePolicy can't be tagged, so the session policy's
    // aws:ResourceTag condition could never authorize touching them. ForwardedValues (inside
    // the taggable distribution) does the same job.
    const types = Object.values(R).map((r) => r.Type);
    expect(types).toEqual(["AWS::CloudFront::Distribution"]);
  });

  it("retains nothing — teardown must remove the whole edge footprint", () => {
    for (const [name, r] of Object.entries(R)) {
      expect(r.DeletionPolicy, `${name} must not be retained`).not.toBe("Retain");
    }
  });

  it("is pure — two builds produce identical bytes (content-addressing depends on it)", () => {
    expect(JSON.stringify(buildEdgeTemplate())).toBe(JSON.stringify(template));
  });
});

/**
 * The statistics page rides the True Reach domain (founder decision 2026-08-04 — browsing
 * stats.<domain> was a bare 404). Collection must stay pinned to the collector whatever
 * the default behavior does, and everything viewer-related must switch off cleanly when
 * the core stack predates the viewer plane.
 */
describe("the dashboard on the True Reach domain", () => {
  it("keeps /t.js and /e pinned to the collector — a slow page can never break beacons", () => {
    const behaviors = resolveIf(dist.CacheBehaviors, true);
    expect(behaviors.map((b: any) => b.PathPattern)).toEqual(["/t.js", "/e"]);
    for (const b of behaviors) expect(b.TargetOriginId).toBe("collector");
  });

  it("routes everything else to the viewer when one exists, else to the collector", () => {
    expect(resolveIf(behavior.TargetOriginId, true)).toBe("viewer");
    expect(resolveIf(behavior.TargetOriginId, false)).toBe("collector");
  });

  it("forwards the bearer token to the viewer — sign-in dies at the edge otherwise", () => {
    expect(defaultHeaders(true)).toContain("authorization");
    // No viewer, no token to forward — and the beacon path must not grow headers.
    expect(defaultHeaders(false)).not.toContain("authorization");
  });

  it("the viewer origin is HTTPS-only and does NOT get the x-tp-host header", () => {
    const viewer = resolveIf(dist.Origins, true).find((o: any) => o.Id === "viewer");
    expect(viewer.CustomOriginConfig.OriginProtocolPolicy).toBe("https-only");
    expect(viewer.OriginCustomHeaders).toBeUndefined();
    expect(viewer.DomainName).toEqual({ Ref: "ViewerUrlHost" });
  });

  it("stays deployable against a pre-viewer core stack (parameter defaults empty)", () => {
    const p = (template.Parameters as Record<string, any>).ViewerUrlHost;
    expect(p.Default).toBe("");
    expect(resolveIf(dist.Origins, false).map((o: any) => o.Id)).toEqual(["collector"]);
    expect(resolveIf(dist.CacheBehaviors, false)).toEqual({ Ref: "AWS::NoValue" });
  });

  it("never caches the dashboard or the API (the page is no-store)", () => {
    expect(behavior.MinTTL).toBe(0);
    expect(behavior.MaxTTL).toBe(0);
    for (const b of resolveIf(dist.CacheBehaviors, true)) expect(b.MaxTTL).toBe(0);
  });
});

describe("lockstep with the manifest", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../extension.json", import.meta.url), "utf8")) as {
    permissionSet: { grants: { service: string; actions: string[]; resourceScope: string }[] };
  };
  const grantOf = (service: string) => manifest.permissionSet.grants.find((g) => g.service === service);

  it("the cloudformation scope covers the edge stack's name", () => {
    const scope = grantOf("cloudformation")!.resourceScope;
    const arn = `arn:aws:cloudformation:${EDGE_REGION}:123456789012:stack/${EDGE_STACK_NAME}/abc-123`;
    const re = new RegExp(`^${scope.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    expect(re.test(arn)).toBe(true);
  });

  it("acm + cloudfront grants exist and are tagged-as-self (never '*')", () => {
    for (const svc of ["acm", "cloudfront"]) {
      const g = grantOf(svc);
      expect(g, `${svc} grant`).toBeDefined();
      expect(g!.resourceScope).toBe("tagged-as-self");
    }
  });

  it("declares no grant for the untaggable OriginRequestPolicy family", () => {
    const cfActions = grantOf("cloudfront")!.actions.join(",");
    expect(cfActions).not.toMatch(/OriginRequestPolicy|CachePolicy/);
  });
});
