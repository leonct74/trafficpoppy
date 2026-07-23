import { CopyButton } from "./CopyButton";
import type { Site } from "./types";

/**
 * The Integrate screen (DESIGN.md §7.4): the owner's data is a documented, stable DynamoDB
 * table in THEIR account — this screen hands them the schema and ready-made queries, so
 * "your data is yours" is a working fact, not a slogan. Examples are baked with the real
 * site id, table and region, ready to paste.
 */
export function Integrate(props: { site: Site; region: string; tableName: string; onBack: () => void }) {
  const { site, region, tableName } = props;
  const today = new Date().toISOString().slice(0, 10);

  const cliDay = `aws dynamodb query \\
  --table-name ${tableName} --region ${region} \\
  --key-condition-expression "pk = :p" \\
  --expression-attribute-values '{":p":{"S":"site#${site.id}#day#${today}"}}'`;

  const cliPages = `aws dynamodb query \\
  --table-name ${tableName} --region ${region} \\
  --key-condition-expression "pk = :p AND begins_with(sk, :s)" \\
  --expression-attribute-values '{":p":{"S":"site#${site.id}#day#${today}"},":s":{"S":"page#"}}'`;

  const nodeSnippet = `import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";

const db = new DynamoDBClient({ region: "${region}" });
const day = new Date().toISOString().slice(0, 10);
const { Items } = await db.send(new QueryCommand({
  TableName: "${tableName}",
  KeyConditionExpression: "pk = :p",
  ExpressionAttributeValues: { ":p": { S: \`site#${site.id}#day#\${day}\` } },
}));
// Items: [{ sk: { S: "total#views" }, count: { N: "42" } }, ...]`;

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row">
          <button className="btn btn-sm" onClick={props.onBack} aria-label="Back to the dashboard">
            ← Dashboard
          </button>
          <div>
            <strong>Use your data anywhere</strong>{" "}
            <span className="muted mono" style={{ fontSize: 12 }}>
              {site.domain || site.name}
            </span>
          </div>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Everything TrafficPoppy collects lives in one DynamoDB table in <strong>your</strong> AWS account.
          The schema below is stable and documented — point any tool at it; nothing is locked in and nothing
          leaves your account.
        </p>
      </div>

      <div className="card card-2 stack" style={{ marginBottom: 0 }}>
        <div className="section-title" style={{ margin: 0 }}>
          The table
        </div>
        <dl className="stack" style={{ margin: 0, gap: 6 }}>
          <Fact label="Table" value={tableName} />
          <Fact label="Region" value={region} />
          <Fact label="This site's id" value={site.id} />
          <Fact label="Billing" value="on-demand — reads cost fractions of a cent" />
          {/* The abuse cap, surfaced (DESIGN.md §13 P4): the collector stops counting a
              site past this many views per day, so a spammed public endpoint can cost at
              most ~one write per hit — the bill is bounded even under abuse. */}
          <Fact label="Abuse protection" value="counting stops past 100,000 views/site/day" />
        </dl>
      </div>

      <div className="card card-2 stack" style={{ marginBottom: 0 }}>
        <div className="section-title" style={{ margin: 0 }}>
          Row shapes (one row per counter)
        </div>
        <table style={{ borderCollapse: "collapse", fontSize: 13, width: "100%" }}>
          <thead>
            <tr className="muted" style={{ textAlign: "left", fontSize: 12 }}>
              <th style={{ padding: "4px 8px" }}>pk</th>
              <th style={{ padding: "4px 8px" }}>sk</th>
              <th style={{ padding: "4px 8px" }}>meaning</th>
            </tr>
          </thead>
          <tbody>
            <Row pk={`site#${site.id}#day#YYYY-MM-DD`} sk="total#views · total#uniques" what="the day's totals" />
            <Row pk="〃" sk="page#/pricing · ref#google.com" what="per-page and per-referrer counts" />
            <Row pk="〃" sk="browser#… · os#… · size#… · hour#HH" what="device and time-of-day splits" />
            <Row pk="〃" sk="utm_source#… · utm_medium#… · utm_campaign#…" what="campaign attribution" />
            <Row pk={`site#${site.id}#recent`} sk="t#YYYY-MM-DDTHH:MM" what="live ticker minutes (self-delete after 2 h)" />
          </tbody>
        </table>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Every row is just <span className="mono">count</span> (a number). The private internals — daily-unique
          hashes and the daily salt — expire on their own and are never meaningful outside their day, by design.
        </p>
      </div>

      <Snippet title="Read a day with the AWS CLI" text={cliDay} copyLabel="CLI query" />
      <Snippet title="Just the pages (key prefix query)" text={cliPages} copyLabel="pages query" />
      <Snippet title="From your own code (Node.js)" text={nodeSnippet} copyLabel="Node snippet" />

      <div className="card card-2 stack" style={{ marginBottom: 0 }}>
        <div className="section-title" style={{ margin: 0 }}>
          Athena / QuickSight
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          SQL over your analytics arrives with the planned S3 daily rollups — the table above stays the live
          source of truth either way.
        </p>
      </div>
    </div>
  );
}

function Fact(props: { label: string; value: string }) {
  return (
    <div className="spread">
      <span className="muted" style={{ fontSize: 12 }}>
        {props.label}
      </span>
      <span className="chip">{props.value}</span>
    </div>
  );
}

function Row(props: { pk: string; sk: string; what: string }) {
  return (
    <tr style={{ borderTop: "1px solid var(--poppy-border)" }}>
      <td className="mono" style={{ padding: "4px 8px", fontSize: 12, whiteSpace: "nowrap" }}>{props.pk}</td>
      <td className="mono" style={{ padding: "4px 8px", fontSize: 12 }}>{props.sk}</td>
      <td className="muted" style={{ padding: "4px 8px" }}>{props.what}</td>
    </tr>
  );
}

function Snippet(props: { title: string; text: string; copyLabel: string }) {
  return (
    <div className="card card-2 stack" style={{ marginBottom: 0 }}>
      <div className="spread">
        <div className="section-title" style={{ margin: 0 }}>
          {props.title}
        </div>
        <CopyButton text={props.text} label={props.copyLabel} />
      </div>
      <pre
        className="mono"
        style={{
          margin: 0,
          padding: "10px 12px",
          fontSize: 12,
          lineHeight: 1.5,
          background: "var(--poppy-surface-0)",
          border: "1px solid var(--poppy-border)",
          borderRadius: 8,
          overflowX: "auto",
        }}
      >
        {props.text}
      </pre>
    </div>
  );
}
