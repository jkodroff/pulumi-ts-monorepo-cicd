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

// Lets .github/workflows/deploy-prod.yml exchange GitHub's OIDC token for a Pulumi one,
// so the repo needs no PULUMI_ACCESS_TOKEN secret.
//
// Every github.com repo, in every GitHub org, mints its token from the same issuer URL,
// and Pulumi allows one registration per URL per org — so the issuer is org-wide setup
// shared with every other repo, and what distinguishes this one is the `sub` rule below.
// Most orgs already have it registered: point `oidcIssuerId` at it. `registerOidcIssuer`
// is for an org that has none, and defaults to false so this never fights over an issuer
// other pipelines depend on.
const oidcIssuerId = cfg.get("oidcIssuerId");
const registerOidcIssuer = cfg.getBoolean("registerOidcIssuer") ?? false;

const githubActionsPolicy = {
    decision: service.AuthPolicyDecision.Allow,
    tokenType: service.AuthPolicyTokenType.Organization,
    authorizedPermissions: [service.AuthPolicyPermissionLevel.Admin],

    // `aud` is what the workflow asks for; `sub` is what GitHub asserts about the run.
    // Narrowing `*` to `ref:refs/tags/prod` would let only the tag workflow mint a
    // token, at the cost of the workflow_dispatch fallback.
    rules: {
        aud: `urn:pulumi:org:${org}`,
        sub: `repo:${repository}:*`,
    },
};

if (registerOidcIssuer) {
    new service.OidcIssuer("github-actions", {
        organization: org,
        name: "GitHub Actions",
        url: "https://token.actions.githubusercontent.com",
        maxExpirationSeconds: 60 * 60,
        policies: [githubActionsPolicy],
    });
} else if (oidcIssuerId) {
    new service.api.auth.Policy("github-actions", {
        orgName: org,
        issuerId: oidcIssuerId,
        policyId: `${pulumi.getProject()}-prod-deploy`,
        policies: [githubActionsPolicy],
    });
}

export const configuredRepository = repository;
