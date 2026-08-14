# `infra/` — runbook

Three Pulumi programs, two stacks each, one lockfile.

```
infra/
├── package.json          npm workspaces root — the ONLY package.json with devDependencies
├── package-lock.json     the single lockfile for all three programs
├── tsconfig.base.json    shared compiler options
├── networking/           layer 1 — no upstream
├── cluster/              layer 2 — reads networking
└── workload/             layer 3 — reads cluster
```

| Directory | Pulumi project | Stacks |
| --- | --- | --- |
| `networking/` | `monorepo-networking` | `jkodroff-bc/monorepo-networking/{dev,prod}` |
| `cluster/` | `monorepo-cluster` | `jkodroff-bc/monorepo-cluster/{dev,prod}` |
| `workload/` | `monorepo-workload` | `jkodroff-bc/monorepo-workload/{dev,prod}` |

## Gotcha: config keys use the project name, not the directory name

The directory is `networking`, but the Pulumi project is `monorepo-networking`, and
`Pulumi.<stack>.yaml` keys are namespaced by the **project**:

```yaml
config:
  monorepo-networking:cidrBlock: 10.0.0.0/16   # not networking:cidrBlock
```

Get this wrong and you get `Missing required configuration variable
'monorepo-networking:cidrBlock'`, which reads confusingly next to a directory called
`networking`. In TypeScript it stays clean — `new pulumi.Config()` with no argument
already namespaces to the project.

The `monorepo-` prefix exists because `networking` / `cluster` / `workload` are generic
names in an org that already holds hundreds of stacks. Renaming a project after the fact
means renaming every stack plus state surgery, so it is worth getting right up front.

## Setup

```bash
cd infra
npm install          # one install, one lockfile, everything hoisted to infra/node_modules
npm run typecheck    # tsc --noEmit across all three workspaces
```

Sanity checks that the workspace layout is intact:

```bash
npm ls typescript                      # exactly one copy, 5.9.3
ls */node_modules                      # expect: no such file or directory
```

That second check matters. `@pulumi/pulumi` does a bare `require("typescript")` from
inside its own package and relies on Node walking up to `infra/node_modules/typescript`.
If npm ever nests a second copy under a program directory, Pulumi **silently** falls back
to its vendored TypeScript 3.8.3 and modern syntax starts failing at `pulumi up` time
while `tsc` still passes. This is why `typescript`, `ts-node`, and `@types/node` are
declared once, at the root, and pinned — `typescript` in particular must stay below 7,
which is outside `@pulumi/pulumi`'s optional peer range of `>= 3.8.3 < 7`.

## Deploy

**The order is mandatory, not advisory.** Deploy bottom-up:

```bash
(cd networking && pulumi up -s dev --yes)
(cd cluster    && pulumi up -s dev --yes)
(cd workload   && pulumi up -s dev --yes)
```

Same for `prod`. Tear down in reverse (`workload` → `cluster` → `networking`).

### Why the order is mandatory

A `StackReference` is read during **preview**, not just during `up`. Skipping a layer
fails in one of two ways, both of which you can reproduce:

1. **Upstream stack does not exist.** Preview fails before your program runs:

   ```
   pulumi:pulumi:StackReference networking  error: Preview failed:
     unknown stack "jkodroff-bc/monorepo-networking/dev"
   ```

2. **Upstream stack exists but was never deployed.** `pulumi stack init` alone is *not*
   enough — the reference resolves to an empty output map, and `requireOutput` throws:

   ```
   Error: Required output 'vpcId' does not exist on stack
     'jkodroff-bc/monorepo-networking/dev'.
   ```

That second error is the teaching moment: it is the concrete reason a multi-program repo
needs orchestrated deploy ordering, which is what the CI/CD layer will automate.

## How the layers are wired

Each downstream program builds its upstream stack name by convention, so the happy path
needs no configuration at all:

```ts
const org = pulumi.getOrganization();   // never hardcoded — fork-friendly
const stack = pulumi.getStack();        // dev -> dev, prod -> prod
const name = cfg.get("networkingStack") ?? `${org}/monorepo-networking/${stack}`;
const networking = new pulumi.StackReference("networking", { name });
```

The optional `networkingStack` / `clusterStack` config key is the escape hatch for when
the names diverge — an ephemeral `pr-123` cluster reading the shared `dev` network, for
instance. The upstream *project* name stays a literal because it is a structural fact of
this repo, not an environment-varying value.

`workload` reaches a networking value **transitively**: `cluster` re-exports `vpcId` as
`networkVpcId`, so layer 3 never opens a StackReference to layer 1.

### `requireOutput` vs `getOutput`

`workload/index.ts` uses both on purpose:

- `requireOutput("kubeconfig")` — hard dependency; fails the deployment if missing.
- `getOutput("monitoringEndpoint")` — soft dependency on an output `cluster` deliberately
  never exports. It resolves to `undefined` and the deployment succeeds, exporting
  `monitoringConfigured: false`. Use this for outputs an older upstream deployment may
  not have yet.

### Secrets across a stack reference

`cluster` builds a kubeconfig from a real self-signed CA (`@pulumi/tls`). Because
`tls.PrivateKey` marks `privateKeyPem` secret, anything derived from it inherits the
taint; the code also wraps it in `pulumi.secret()` as the explicit, readable form.
`SelfSignedCert.certPem` is **not** secret, and is exported as `caCertPem` for contrast.

The secret survives the hop into `workload`:

```bash
(cd cluster  && pulumi stack output -s dev kubeconfig)                 # [secret]
(cd cluster  && pulumi stack output -s dev --show-secrets kubeconfig)  # the JSON kubeconfig
(cd cluster  && pulumi stack output -s dev caCertPem)                  # plaintext PEM
(cd workload && pulumi stack output -s dev kubeconfigContext)          # [secret]
(cd workload && pulumi stack output -s dev --show-secrets kubeconfigContext)  # funny-mosquito
(cd workload && pulumi stack output -s dev dbPassword)                 # [secret]
```

`kubeconfigContext` is parsed out of the kubeconfig downstream — it proves a real secret
value arrived intact, and it is still marked secret in `workload`'s own state.

## Adding a program

1. `mkdir infra/<name>` with `Pulumi.yaml` (`name: monorepo-<name>`), `package.json`
   (`@infra/<name>`, `@pulumi/*` deps, a `typecheck` script), `tsconfig.json` extending
   `../tsconfig.base.json`, and `index.ts`.
2. Add `"<name>"` to `workspaces` in `infra/package.json`.
3. `npm install` at `infra/` to refresh the single lockfile.

Put `@pulumi/*` in the program's own `package.json`, never at the root: Pulumi's plugin
discovery walks the individual program's manifest. Keep `typescript` / `ts-node` /
`@types/node` at the root only.
