import * as pulumi from "@pulumi/pulumi";
import * as service from "@pulumi/pulumiservice";

import { repoFromGitRemote } from "./repo";

const cfg = new pulumi.Config();

const org = pulumi.getOrganization();
const repository = cfg.get("repository") ?? repoFromGitRemote(`${pulumi.getProject()}:repository`);

const branch = cfg.get("branch") ?? "main";
const infraDir = cfg.get("infraDir") ?? "infra";
const projectPrefix = cfg.get("projectPrefix") ?? "monorepo";

const layers = ["networking", "cluster", "workload"];
const environments = ["dev", "prod"];

const projectOf = (layer: string) => `${projectPrefix}-${layer}`;

const sharedPaths = [
    `${infraDir}/package.json`,
    `${infraDir}/package-lock.json`,
    `${infraDir}/tsconfig.base.json`,
];

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

export const configuredRepository = repository;
