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

export function buildEdgeTemplate(): CfnTemplate {
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
    },
    Resources: {
      // DNS-validated: CloudFormation holds this resource CREATE_IN_PROGRESS until the
      // owner adds the validation CNAME at their DNS host. The sidecar surfaces that
      // record (DescribeCertificate) so the app can show it while the stack waits —
      // background + resumable by construction (AGENTS.md §5).
      Certificate: {
        Type: "AWS::CertificateManager::Certificate",
        Properties: {
          DomainName: { Ref: "DomainName" },
          ValidationMethod: "DNS",
        },
      },

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
              AcmCertificateArn: { Ref: "Certificate" },
              SslSupportMethod: "sni-only",
              MinimumProtocolVersion: "TLSv1.2_2021",
            },
            Origins: [
              {
                Id: "collector",
                DomainName: { Ref: "CollectorUrlHost" },
                CustomOriginConfig: {
                  OriginProtocolPolicy: "https-only",
                  OriginSSLProtocols: ["TLSv1.2"],
                },
                // The one place the public hostname reaches the collector (originOf()
                // prefers it, so t.js keeps posting first-party).
                OriginCustomHeaders: [{ HeaderName: TP_HOST_HEADER, HeaderValue: { Ref: "DomainName" } }],
              },
            ],
            DefaultCacheBehavior: {
              TargetOriginId: "collector",
              ViewerProtocolPolicy: "redirect-to-https",
              AllowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
              CachedMethods: ["GET", "HEAD"],
              // Legacy ForwardedValues (not an OriginRequestPolicy) ON PURPOSE: origin
              // request policies can't be TAGGED, and every mutable resource we own must
              // carry the attribution tags for the tagged-as-self session policy to reach
              // it. ForwardedValues lives inside the (taggable) distribution instead.
              // Host is deliberately NOT in the whitelist — a Function URL routes by its
              // own hostname; the owner's public hostname rides x-tp-host (above).
              ForwardedValues: {
                QueryString: true,
                Cookies: { Forward: "none" }, // we never read cookies, so never forward them
                Headers: ["content-type", "user-agent", "origin", "dnt", "sec-gpc", "cloudfront-viewer-country"],
              },
              // No caching — the collector is dynamic (t.js sets its own browser cache header).
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
      CertificateArn: {
        Description: "The ACM certificate backing the custom domain.",
        Value: { Ref: "Certificate" },
      },
      CollectorDomain: {
        Description: "The public first-party collector hostname.",
        Value: { Ref: "DomainName" },
      },
    },
  };
}
