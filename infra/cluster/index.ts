import * as pulumi from "@pulumi/pulumi";

import { Cluster } from "./cluster";

const cfg = new pulumi.Config();

// Never hardcode the org: getOrganization() is the org of the current update, so this
// repo can be forked into a different Pulumi org without editing any TypeScript.
const org = pulumi.getOrganization();
const stack = pulumi.getStack();

// Convention: the upstream stack shares this stack's name (dev -> dev, prod -> prod),
// which keeps the happy path config-free. The optional override exists for the case
// where the names diverge, e.g. an ephemeral `pr-123` cluster reading the shared dev
// network. The *project* name stays a literal — it is a structural fact of this repo.
const networkingStackName = cfg.get("networkingStack") ?? `${org}/monorepo-networking/${stack}`;
const networking = new pulumi.StackReference("networking", { name: networkingStackName });

// requireOutput: a hard dependency. If monorepo-networking/<stack> has never been
// deployed, this fails the preview rather than silently producing a broken cluster.
const vpcId = networking.requireOutput("vpcId") as pulumi.Output<string>;
const privateSubnetIds = networking.requireOutput("privateSubnetIds") as pulumi.Output<string[]>;
const availabilityZones = networking.requireOutput("availabilityZones") as pulumi.Output<string[]>;

const cluster = new Cluster("main", {
    vpcId,
    subnetIds: privateSubnetIds,
    availabilityZones,
    k8sVersion: cfg.require("k8sVersion"),
    nodeCount: cfg.requireNumber("nodeCount"),
    nodeSize: cfg.require("nodeSize"),
});

export const clusterName = cluster.clusterName;
export const clusterEndpoint = cluster.endpoint;
export const nodeGroupName = cluster.nodeGroup.nodeGroupName;

// Secret. Stays secret when monorepo-workload reads it back over its own StackReference.
export const kubeconfig = cluster.kubeconfig;

// Plaintext, for contrast with kubeconfig in `pulumi stack output`.
export const caCertPem = cluster.caCertPem;

// Re-exported from layer 1 so layer 3 can reach a networking value transitively,
// without opening a second StackReference of its own.
export const networkVpcId = vpcId;
export const networkAvailabilityZones = availabilityZones;
