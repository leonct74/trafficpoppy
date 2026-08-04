// The True Reach edge stack (DESIGN.md §12): an ACM certificate + a CloudFront
// distribution that puts the owner's OWN hostname (stats.<their-domain>) in front of the
// existing collector. First-party collection (ad-blocker immune) + CloudFront-Viewer-
// Country at the edge — the two things the free Function-URL path structurally cannot do.
//
// WHY A SECOND STACK: CloudFront only accepts certificates from us-east-1, whatever
// region the distribution serves — so the cert (and, for cohesion, the distribution,
// which is global anyway) live in their own small stack deployed to us-east-1, beside
// the eu-west-1 core stack. Same leaves-no-trace rules: nothing retained, teardown
// deletes the whole stack.
//
// DNS is deliberately manual-first: the owner adds two CNAMEs at whatever DNS host they
// use (shown with copy buttons in the app) — no Route53 requirement, no extra grants.
//   1. the ACM validation record (the stack waits in CREATE_IN_PROGRESS until it exists)
//   2. stats.<domain> → the distribution's *.cloudfront.net domain

import type { CfnTemplate } from "./template";

export const EDGE_STACK_NAME = "TrafficPoppyEdgeStack";
/** CloudFront only accepts ACM certificates issued in this region. */
export const EDGE_REGION = "us-east-1";
/** The static origin header carrying the owner's public hostname to the collector. */
export const TP_HOST_HEADER = "x-tp-host";

/** The collector's forwarding config — shared by every behavior that targets it. */
const COLLECTOR_FORWARDING = {
  // Legacy ForwardedValues (not an OriginRequestPolicy) ON PURPOSE: origin
  // request policies can't be TAGGED, and every mutable resource we own must
  // carry the attribution tags for the tagged-as-self session policy to reach
  // it. ForwardedValues lives inside the (taggable) distribution instead.
  // Host is deliberately NOT in the whitelist — a Function URL routes by its
  // own hostname; the owner's public hostname rides x-tp-host.
  ForwardedValues: {
    QueryString: true,
    Cookies: { Forward: "none" }, // we never read cookies, so never forward them
    Headers: ["content-type", "user-agent", "origin", "dnt", "sec-gpc", "cloudfront-viewer-country"],
  },
  // No caching — the collector is dynamic (t.js sets its own browser cache header).
  MinTTL: 0,
  DefaultTTL: 0,
  MaxTTL: 0,
} as const;

const collectorBehavior = (pathPattern: string) => ({
  PathPattern: pathPattern,
  TargetOriginId: "collector",
  ViewerProtocolPolicy: "redirect-to-https",
  AllowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
  CachedMethods: ["GET", "HEAD"],
  ...COLLECTOR_FORWARDING,
});

export function buildEdgeTemplate(): CfnTemplate {
  const collectorOrigin = {
    Id: "collector",
    DomainName: { Ref: "CollectorUrlHost" },
    CustomOriginConfig: {
      OriginProtocolPolicy: "https-only",
      OriginSSLProtocols: ["TLSv1.2"],
    },
    // The one place the public hostname reaches the collector (originOf()
    // prefers it, so t.js keeps posting first-party).
    OriginCustomHeaders: [{ HeaderName: TP_HOST_HEADER, HeaderValue: { Ref: "DomainName" } }],
  };
  const viewerOrigin = {
    Id: "viewer",
    DomainName: { Ref: "ViewerUrlHost" },
    CustomOriginConfig: {
      OriginProtocolPolicy: "https-only",
      OriginSSLProtocols: ["TLSv1.2"],
    },
  };
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description:
      "TrafficPoppy True Reach — your own domain in front of your collector (first-party collection + country stats).",
    Parameters: {
      DomainName: {
        Type: "String",
        Description: "The public hostname for collection, e.g. stats.example.com.",
        AllowedPattern: "^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$",
      },
      CollectorUrlHost: {
        Type: "String",
        Description: "The collector Function URL's hostname (no scheme) — the origin.",
      },
      // The statistics page rides the same domain (founder decision 2026-08-04): browsing
      // stats.<domain> shows the dashboard instead of a 404, while /t.js and /e keep going
      // to the collector. Optional so an edge stack can still deploy (or an old one still
      // validate) against a core stack from before the viewer plane existed.
      ViewerUrlHost: {
        Type: "String",
        Default: "",
        Description: "The viewer Function URL's hostname (no scheme) — serves the dashboard. Empty: collector-only.",
      },
      // The certificate is requested by the SIDECAR, not this template: CloudFormation's
      // ACM handler calls RequestCertificate without tags (CloudTrail-proven), which the
      // broker's birth-tag rule (SECURITY_MECHANISM.md I3) rightly refuses. The sidecar
      // requests it WITH the attribution tags and passes the ARN in.
      CertificateArn: {
        Type: "String",
        Description: "ARN of the ISSUED us-east-1 ACM certificate for DomainName.",
      },
    },
    Conditions: {
      // An owner can run this stack against a core stack from before the viewer plane
      // existed — everything viewer-related switches off rather than failing to deploy.
      HasViewer: { "Fn::Not": [{ "Fn::Equals": [{ Ref: "ViewerUrlHost" }, ""] }] },
    },
    Resources: {
      Distribution: {
        Type: "AWS::CloudFront::Distribution",
        Properties: {
          DistributionConfig: {
            Enabled: true,
            Comment: "TrafficPoppy True Reach collector",
            HttpVersion: "http2and3",
            // Cheapest class: NA + EU edge locations. Viewer-country still resolves for
            // every visitor worldwide; farther visitors just hit a farther edge.
            PriceClass: "PriceClass_100",
            Aliases: [{ Ref: "DomainName" }],
            ViewerCertificate: {
              AcmCertificateArn: { Ref: "CertificateArn" },
              SslSupportMethod: "sni-only",
              MinimumProtocolVersion: "TLSv1.2_2021",
            },
            Origins: { "Fn::If": ["HasViewer", [collectorOrigin, viewerOrigin], [collectorOrigin]] },
            // The two collection paths stay pinned to the collector whatever the default
            // does — a viewer outage or slow page can never break beacon ingestion.
            CacheBehaviors: {
              "Fn::If": [
                "HasViewer",
                [collectorBehavior("/t.js"), collectorBehavior("/e")],
                { Ref: "AWS::NoValue" },
              ],
            },
            // Everything that isn't collection is the statistics page: browsing the bare
            // domain shows the dashboard (previously a 404 — founder feedback 2026-08-04).
            DefaultCacheBehavior: {
              TargetOriginId: { "Fn::If": ["HasViewer", "viewer", "collector"] },
              ViewerProtocolPolicy: "redirect-to-https",
              AllowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
              CachedMethods: ["GET", "HEAD"],
              ForwardedValues: {
                QueryString: true,
                Cookies: { Forward: "none" }, // we never read cookies, so never forward them
                // The viewer needs the bearer token; the collector its beacon headers.
                // One superset list (ForwardedValues, so it must be static): with TTL 0
                // nothing is cached, so over-forwarding costs nothing.
                Headers: {
                  "Fn::If": [
                    "HasViewer",
                    ["authorization", ...COLLECTOR_FORWARDING.ForwardedValues.Headers],
                    [...COLLECTOR_FORWARDING.ForwardedValues.Headers],
                  ],
                },
              },
              // No caching — the page is no-store and the collector is dynamic.
              MinTTL: 0,
              DefaultTTL: 0,
              MaxTTL: 0,
            },
          },
        },
      },
    },
    Outputs: {
      DistributionDomain: {
        Description: "Point stats.<domain> at this with a CNAME.",
        Value: { "Fn::GetAtt": ["Distribution", "DomainName"] },
      },
      CollectorDomain: {
        Description: "The public first-party collector hostname.",
        Value: { Ref: "DomainName" },
      },
    },
  };
}
