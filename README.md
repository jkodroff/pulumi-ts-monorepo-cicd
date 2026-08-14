# pulumi-ts-monorepo-cicd

Example of a Pulumi monorepo with multiple programs, multiple stacks per program, and CI/CD.

Three TypeScript programs in a layered `networking → cluster → workload` pattern, two
stacks each (`dev` and `prod`), wired together by stack references, sharing a single
`package-lock.json` via npm workspaces.

```
infra/
├── package.json          npm workspaces root
├── package-lock.json     the single lockfile for all three programs
├── tsconfig.base.json
├── networking/           layer 1 — VPC, subnets, AZs. No upstream.
├── cluster/              layer 2 — reads networking's outputs, exports a secret kubeconfig
└── workload/             layer 3 — reads cluster's outputs, reaches networking transitively
```

| Layer | Pulumi project | Consumes | Exports |
| --- | --- | --- | --- |
| `networking` | `monorepo-networking` | — | `vpcId`, `cidrBlock`, `publicSubnetIds`, `privateSubnetIds`, `availabilityZones` |
| `cluster` | `monorepo-cluster` | networking | `clusterName`, `clusterEndpoint`, `kubeconfig` (secret), `caCertPem`, `networkVpcId` |
| `workload` | `monorepo-workload` | cluster | `releaseName`, `appEndpoint`, `dbPassword` (secret), `placedInVpc`, `monitoringConfigured` |

## No credentials, no cloud spend

The point of this repo is the **pattern** — multiple programs, multiple stacks per
program, and outputs flowing downstream — not any particular cloud. So the only
providers used are [`@pulumi/random`](https://www.pulumi.com/registry/packages/random/)
and [`@pulumi/tls`](https://www.pulumi.com/registry/packages/tls/). Nothing is
provisioned, nothing is billed, and no cloud credentials are needed to run any of it.

The resources are wrapped in `ComponentResource` subclasses named `Vpc`, `Subnet`,
`Cluster`, `NodeGroup`, and `App`, so URNs and stack outputs read like the real thing:

```
urn:pulumi:dev::monorepo-networking::monorepo:networking:Vpc$monorepo:networking:Subnet$
  random:index/randomId:RandomId::main-private-0
```

Swapping in a real cloud provider is a per-layer change; the cross-stack wiring, the
workspace layout, and the deploy ordering all stay exactly as they are.

## What it demonstrates

- **npm workspaces** — one `npm install`, one `package-lock.json`, dependencies hoisted
  to `infra/node_modules`, with `@pulumi/*` declared per program so Pulumi's plugin
  discovery stays correct.
- **Cross-stack references** — `cluster` reads `networking`, `workload` reads `cluster`,
  and `workload` reaches a networking value transitively without a second reference.
- **Convention-based stack naming** — upstream stack names are derived from
  `pulumi.getOrganization()` and `pulumi.getStack()`, with a config key as the override
  for when names diverge. No org is hardcoded anywhere.
- **`requireOutput` vs `getOutput`** — a hard dependency that fails the deployment beside
  a soft one that degrades to `undefined`.
- **Secrets across a stack reference** — a kubeconfig built from a real self-signed CA
  stays encrypted end to end, next to a deliberately plaintext cert for contrast.
- **Per-stack config divergence** — `dev` gets 2 AZs and 2 small nodes; `prod` gets 3 AZs
  and 5 large ones, from committed `Pulumi.<stack>.yaml` files.

## Quick start

```bash
cd infra
npm install
npm run typecheck

# Deploy bottom-up. The order is mandatory — a StackReference is read during preview,
# so a downstream stack cannot even be previewed until its upstream is deployed.
(cd networking && pulumi up -s dev --yes)
(cd cluster    && pulumi up -s dev --yes)
(cd workload   && pulumi up -s dev --yes)
```

See [`infra/README.md`](infra/README.md) for the full runbook: stack names, the
project-name config-key gotcha, the exact errors you hit if you skip a layer, and how to
add a fourth program.

## CI/CD

Not yet — coming in a later pass. It will automate the deploy ordering above:
path-filtered preview on PR, `up` on merge, and the layer dependency enforced across
jobs.
