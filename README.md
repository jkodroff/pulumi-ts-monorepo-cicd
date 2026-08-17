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

pulumi-cloud/             layer 0 — the pipeline itself, as a Pulumi program
.github/workflows/        the prod promotion, the one piece Deployments can't express
```

| Layer | Pulumi project | Consumes | Exports |
| --- | --- | --- | --- |
| `networking` | `monorepo-networking` | — | `vpcId`, `cidrBlock`, `publicSubnetIds`, `privateSubnetIds`, `availabilityZones` |
| `cluster` | `monorepo-cluster` | networking | `clusterName`, `clusterEndpoint`, `kubeconfig` (secret), `caCertPem`, `networkVpcId` |
| `workload` | `monorepo-workload` | cluster | `releaseName`, `appEndpoint`, `dbPassword` (secret), `placedInVpc`, `monitoringConfigured` |

The layers are built from `FakeVpc`, `FakeSubnet`, `FakeCluster`, `FakeNodeGroup`, and
`FakeApp` — Components with realistic inputs and outputs that use `random` and `tls`
provider resources internally, so there are actual Pulumi resources in every stack, but
none that require cloud spend or credentials.

## Quick start

```bash
cd infra/networking && pulumi install    # detects the workspace root, installs once for all three
```

Then deploy bottom-up:

```bash
(cd networking && pulumi up -s dev --yes)
(cd cluster    && pulumi up -s dev --yes)
(cd workload   && pulumi up -s dev --yes)
```

Same for `prod`. Tear down in reverse.

The order is mandatory, not advisory: a `StackReference` is read during **preview**, so a
downstream stack cannot even be previewed until its upstream has been deployed.
`pulumi stack init` alone is not enough — the reference resolves to an empty output map
and you get `Required output 'vpcId' does not exist on stack '…'`. Automating that
ordering is the job of the CI/CD layer.

Config keys are namespaced by the Pulumi **project**, not the directory, so
`networking/Pulumi.dev.yaml` uses `monorepo-networking:cidrBlock`.

## How the layers are wired

Each downstream program builds its upstream stack name by convention, so the happy path
needs no configuration:

```ts
const org = pulumi.getOrganization();   // never hardcoded — fork-friendly
const stack = pulumi.getStack();        // dev -> dev, prod -> prod
const name = cfg.get("networkingStack") ?? `${org}/monorepo-networking/${stack}`;
const networking = new pulumi.StackReference("networking", { name });
```

The optional `networkingStack` / `clusterStack` config key is the escape hatch for when
the names diverge — an ephemeral `pr-123` cluster reading the shared `dev` network, say.

`workload` reaches a networking value **transitively**: `cluster` re-exports `vpcId` as
`networkVpcId`, so layer 3 never opens a StackReference to layer 1. It also uses both
accessors on purpose — `requireOutput("kubeconfig")` as a hard dependency, and
`getOutput("monitoringEndpoint")` on an output `cluster` deliberately never exports, which
resolves to `undefined` and lets the deployment succeed with `monitoringConfigured: false`.

The kubeconfig is built from a real self-signed CA and stays secret across the reference;
`caCertPem` is deliberately left plaintext for contrast:

```bash
(cd cluster  && pulumi stack output -s dev kubeconfig)                        # [secret]
(cd workload && pulumi stack output -s dev --show-secrets kubeconfigContext)  # funny-mosquito
```

## CI/CD

Every update runs in Pulumi Deployments. There are three triggers:

| Trigger | Runs | How it stays ordered |
| --- | --- | --- |
| PR opened or pushed | `pulumi preview` on the layer whose path changed, `dev` **and** `prod` | n/a — previews are independent |
| merge to `main` | `pulumi up` on the three `dev` stacks | `update_succeeded` webhooks chain each layer to the next |
| `prod` tag moved | `pulumi up` on the three `prod` stacks, at the tagged commit | a loop in `.github/workflows/deploy-prod.yml` |

A merge never touches `prod`. Promotion is moving the tag:

```bash
git tag -f prod <sha> && git push -f origin prod
```

`pulumi-cloud/` declares all of it with `@pulumi/pulumiservice` — six
`DeploymentSettings` and two `Webhook`s. Org comes from `getOrganization()` and
`owner/repo` is read off `git remote origin`, so you can clone this repo under any name
into any org and nothing needs editing; `Pulumi.main.yaml` lists the overrides. Bootstrap
it once, in the org holding the stacks:

```bash
(cd pulumi-cloud && npm install && pulumi stack init <org>/main && pulumi up)
```

Also needs: the Pulumi GitHub App on the repo, all six stacks deployed once bottom-up, a
`PULUMI_ACCESS_TOKEN` secret, and a `PULUMI_ORG` variable if that token's default org
isn't the stacks'.

Three things that aren't obvious:

- `prod` uses Actions rather than the webhook chain because tag triggers aren't exposed on
  `DeploymentSettings`, and a webhook fires the target stack at *its* branch — so layers 2
  and 3 would deploy from `main`, not the tag. `--git-commit` pins all three.
- A downstream preview resolves its `StackReference` against the **deployed** upstream, not
  the PR's version of it.
- The webhooks fire on any successful update of the upstream stack, including a local
  `pulumi up`.
