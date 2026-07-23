import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildEdgeTemplate, EDGE_REGION, EDGE_STACK_NAME, TP_HOST_HEADER } from "./edge-template";

const template = buildEdgeTemplate();
const R = template.Resources as Record<string, { Type: string; Properties: any; DeletionPolicy?: string }>;
const dist = R.Distribution!.Properties.DistributionConfig;
const behavior = dist.DefaultCacheBehavior;

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
    const headers: string[] = behavior.ForwardedValues.Headers;
    expect(headers).toContain("cloudfront-viewer-country"); // the whole point of the tier
    expect(headers).toContain("sec-gpc"); // GPC/DNT must survive the edge — privacy invariant
    expect(headers).toContain("dnt");
    // A Function URL routes by its own hostname; forwarding the viewer Host would 403 at origin.
    expect(headers.map((h) => h.toLowerCase())).not.toContain("host");
  });

  it("carries the public hostname to the collector via the static origin header", () => {
    const origin = dist.Origins[0];
    expect(origin.OriginCustomHeaders).toEqual([
      { HeaderName: TP_HOST_HEADER, HeaderValue: { Ref: "DomainName" } },
    ]);
    expect(origin.CustomOriginConfig.OriginProtocolPolicy).toBe("https-only");
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
