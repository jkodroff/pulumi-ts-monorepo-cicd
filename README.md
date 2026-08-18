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
cd infra
pulumi install -C networking    # detects the workspace root, installs once for all three

export PULUMI_ORG=<your-org>
for env in dev prod; do
  for layer in networking cluster workload; do
    (cd $layer && pulumi stack init "$PULUMI_ORG/$env" && pulumi up -s "$env" --yes)
  done
done
```

`pulumi up` will not create a missing stack, hence the `stack init`. Tear down in reverse
— `workload`, `cluster`, `networking`.

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
`DeploymentSettings` and two `Webhook`s. `Pulumi.main.yaml` lists the config overrides;
you shouldn't need any.

### Running it on your own fork

Order matters: `DeploymentSettings` 404s against a stack that doesn't exist, so the six
stacks come first.

1. Fork this repo, or use it as a template, and clone it. Nothing needs editing — the org
   comes from `getOrganization()`, and `owner/repo` is read off `git remote origin`.
2. Give the [Pulumi GitHub App](https://www.pulumi.com/docs/integrations/version-control/github-app/)
   access to the new repo. Deployments can only see repos you grant it.
3. Run the Quick start above. All six stacks have to exist *and* be deployed.
4. Bootstrap the pipeline, in the org holding those stacks:

   ```bash
   cd pulumi-cloud    # from the repo root; the Quick start leaves you in infra/
   npm install
   pulumi stack init "$PULUMI_ORG/main"
   pulumi up
   ```

5. Tell the workflow which org to authenticate against:

   ```bash
   gh variable set PULUMI_ORG --body "$PULUMI_ORG"
   ```

6. Turn on OIDC, so there's no access token to store — see below.
7. Cut the first release: `git tag prod main && git push origin prod`.

### OIDC instead of a token secret

The tag workflow authenticates by exchanging GitHub's OIDC token for a Pulumi one
(`pulumi/auth-actions`), so no `PULUMI_ACCESS_TOKEN` secret is needed. Pulumi Cloud has to
trust the issuer first, and `pulumi-cloud/` does that — but which half it does is up to
config, because **the issuer is org-wide, not per-repo**. Every github.com repo in every
GitHub org mints its token from the same URL, and Pulumi allows one registration per URL
per org, so what identifies *this* repo is the `sub` rule in the auth policy.

| Your org | Set | What gets created |
| --- | --- | --- |
| already has a GitHub issuer (most do) | `oidcIssuerId: <uuid>` | an auth policy on it |
| has none | `registerOidcIssuer: true` | the issuer, with that policy inline |
| neither | — | nothing; the workflow can't authenticate |

Find an existing issuer's id under **Settings → Access Management → OIDC Issuers**.
`registerOidcIssuer` defaults to `false` on purpose: registering is org-wide setup that
other pipelines already depend on, and a demo repo shouldn't fight them for it.

The policy grants an `admin` organization token scoped to `repo:<owner>/<repo>:*` —
`admin` because that is the only permission level Pulumi supports for organization
tokens. Tighten `sub` to `repo:<owner>/<repo>:ref:refs/tags/prod` to let only the tag
workflow mint one, at the cost of the `workflow_dispatch` fallback.

Three things that aren't obvious:

- `prod` uses Actions rather than the webhook chain because tag triggers aren't exposed on
  `DeploymentSettings`, and a webhook fires the target stack at *its* branch — so layers 2
  and 3 would deploy from `main`, not the tag. `--git-commit` pins all three.
- A downstream preview resolves its `StackReference` against the **deployed** upstream, not
  the PR's version of it.
- The webhooks fire on any successful update of the upstream stack, including a local
  `pulumi up`.
