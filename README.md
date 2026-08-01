# TrafficPoppy

Privacy-first web analytics that run **entirely in your own AWS account** — an
[AgentsPoppy](https://agentspoppy.com) poppy.

- **No vendor in the data path.** Visitor data goes from your website straight into your
  cloud. Nobody else ever sees a byte.
- **Banner-free by design.** No cookies, no identifiers at rest, daily-rotating salt for
  uniques, IPs never stored — anonymous aggregates only.
- **First-party collection** that ad blockers can't enumerate.
- **Your data is an open surface**: documented schema + first-party read API — plug in
  Athena, Grafana, or any BI tool.
- **Cents per month**, serverless, unlimited sites and retention.

**Status: in development** (planning complete — see [`DESIGN.md`](DESIGN.md) for the full
architecture, privacy design, and roadmap). Free core; one optional premium feature
("True Reach": custom-domain collection + geography) sold through AgentsPoppy's in-app
checkout.

## License

Source-available under the **[PolyForm Shield License 1.0.0](https://polyformproject.org/licenses/shield/1.0.0/)**
— see [`LICENSE`](./LICENSE). Read it, run it, self-host it, change it, and use it for any
purpose *except* building a product that competes with TrafficPoppy or with any other
product we provide using it. The TrafficPoppy name and brand are not licensed with the code.

(`frontend/src/poppy.css` is the AgentsPoppy design kit, vendored in under its own MIT
header — that file keeps its MIT terms.)
