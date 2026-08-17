import * as pulumi from "@pulumi/pulumi";
import * as service from "@pulumi/pulumiservice";

import { repoFromGitRemote } from "./repo";

const cfg = new pulumi.Config();

// Nothing about this program's identity is hardcoded. The org comes from the access
// token running the update, the repo from `git remote origin`. Clone this repo under a
// different name into a different org and `pulumi up` still configures the right thing.
const org = pulumi.getOrganization();
const repository = cfg.get("repository") ?? repoFromGitRemote(`${pulumi.getProject()}:repository`);

const branch = cfg.get("branch") ?? "main";
const infraDir = cfg.get("infraDir") ?? "infra";
const selfDir = cfg.get("selfDir") ?? "pulumi-cloud";
const projectPrefix = cfg.get("projectPrefix") ?? "monorepo";

// Ordered bottom-up. This array *is* the dependency graph: index 0 is the only stack
// that CI triggers directly, and each adjacent pair below becomes one webhook.
const layers = ["networking", "cluster", "workload"];
const environments = ["dev", "prod"];

const projectOf = (layer: string) => `${projectPrefix}-${layer}`;

// Files outside any one layer's directory that still change every layer's behavior.
// A PR touching only these should preview all six stacks, not none of them.
const sharedPaths = [
    `${infraDir}/package.json`,
    `${infraDir}/package-lock.json`,
    `${infraDir}/tsconfig.base.json`,
];

// ---------------------------------------------------------------------------
// Deployment settings: one per program per environment.
// ---------------------------------------------------------------------------

for (const layer of layers) {
    for (const environment of environments) {
        // The single entry point for the merge-to-main pipeline. Everything downstream
        // of it is reached by webhook (below), which is what makes the deploy ordered
        // instead of six simultaneous updates racing their own StackReferences.
        const isMergeEntryPoint = layer === layers[0] && environment === "dev";

        new service.DeploymentSettings(`${layer}-${environment}`, {
            organization: org,
            project: projectOf(layer),
            stack: environment,

            // No repoUrl and no gitAuth: the GitHub App integration supplies both, and
            // the provider rejects gitAuth when VCS settings are present.
            sourceContext: {
                git: {
                    branch,
                    repoDir: `${infraDir}/${layer}`,
                },
            },

            vcs: {
                provider: "github",
                repository,

                // Every stack previews on a PR, dev and prod alike - a prod preview is
                // the whole point of reviewing an infra change.
                previewPullRequests: true,

                // This is the Review Stacks toggle (use this stack as the template for
                // ephemeral per-PR stacks), not the PR preview toggle. Off on purpose.
                pullRequestTemplate: false,

                deployCommits: isMergeEntryPoint,

                // Path filters decide which stacks a PR previews. The entry point widens
                // to all of infra/ so that any infra change starts the full dev cascade
                // on merge; the other five filter to their own layer.
                paths: isMergeEntryPoint
                    ? [`${infraDir}/**`]
                    : [`${infraDir}/${layer}/**`, ...sharedPaths],
            },
        });
    }
}

// ---------------------------------------------------------------------------
// Webhooks: the ordering mechanism for the dev pipeline.
// ---------------------------------------------------------------------------

// `update_succeeded` and nothing else. Adding a second lifecycle filter here is the
// documented way to make a chain fire twice per update.
for (let i = 0; i < layers.length - 1; i++) {
    const upstream = layers[i];
    const downstream = layers[i + 1];

    new service.Webhook(`${upstream}-to-${downstream}-dev`, {
        organizationName: org,
        projectName: projectOf(upstream),
        stackName: "dev",
        displayName: `deploy ${projectOf(downstream)}/dev`,
        format: service.WebhookFormat.PulumiDeployments,
        payloadUrl: `${projectOf(downstream)}/dev`,
        filters: [service.WebhookFilters.UpdateSucceeded],
        active: true,
    });
}

// No prod webhooks. A webhook-triggered deployment runs with the *target* stack's own
// source settings, so a tag-initiated cascade would deploy layers 2 and 3 from the tip
// of `main` rather than from the tagged commit. .github/workflows/deploy-prod.yml drives
// prod instead, pinning every layer to the tagged SHA.

// ---------------------------------------------------------------------------
// This program configures itself too.
// ---------------------------------------------------------------------------

// Chicken-and-egg: the first apply has to be a local `pulumi up`. After that, changes to
// the CI/CD config flow through the same preview-on-PR / deploy-on-merge pipeline as the
// infrastructure it configures. A local `pulumi up` also remains the recovery path if a
// bad change here breaks the pipeline.
new service.DeploymentSettings("pulumi-cloud", {
    organization: org,
    project: pulumi.getProject(),
    stack: pulumi.getStack(),
    sourceContext: {
        git: {
            branch,
            repoDir: selfDir,
        },
    },
    vcs: {
        provider: "github",
        repository,
        previewPullRequests: true,
        pullRequestTemplate: false,
        deployCommits: true,
        paths: [`${selfDir}/**`],
    },
});

export const configuredRepository = repository;
export const configuredStacks = layers.flatMap((layer) =>
    environments.map((environment) => `${org}/${projectOf(layer)}/${environment}`),
);
