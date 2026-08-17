import * as pulumi from "@pulumi/pulumi";

import { FakeApp } from "./app";

const cfg = new pulumi.Config();
const org = pulumi.getOrganization();
const stack = pulumi.getStack();

// Same convention as layer 2, one link further down the chain.
const clusterStackName = cfg.get("clusterStack") ?? `${org}/monorepo-cluster/${stack}`;
const cluster = new pulumi.StackReference("cluster", { name: clusterStackName });

// requireOutput: hard dependency. The kubeconfig is secret upstream and stays secret here.
const kubeconfig = cluster.requireOutput("kubeconfig") as pulumi.Output<string>;
const clusterName = cluster.requireOutput("clusterName") as pulumi.Output<string>;

// Reached transitively: monorepo-cluster re-exports it from monorepo-networking, so this
// program never opens a StackReference to layer 1.
const vpcId = cluster.requireOutput("networkVpcId") as pulumi.Output<string>;

// getOutput: soft dependency. monorepo-cluster deliberately never exports this, so instead
// of failing the deployment the way requireOutput would, it resolves to undefined and the
// program degrades. This is the accessor to use for outputs an older upstream deployment
// may not have yet.
const monitoringEndpoint = cluster.getOutput("monitoringEndpoint");

const app = new FakeApp("guestbook", {
    kubeconfig,
    clusterName,
    appName: cfg.require("appName"),
    replicas: cfg.requireNumber("replicas"),
    dbPasswordLength: cfg.requireNumber("dbPasswordLength"),
});

export const releaseName = app.releaseName;
export const appEndpoint = app.endpoint;
export const replicas = app.replicas;
export const dbPassword = app.dbPassword;

// Proof the secret survived the hop: this is derived from the kubeconfig, so it is
// itself secret, and its value confirms a real kubeconfig (not undefined) arrived.
export const kubeconfigContext = app.kubeconfigContext;

// Where the workload was placed, sourced two layers up.
export const placedInVpc = vpcId;

// false — and the deployment succeeds anyway. That is the whole point of getOutput.
export const monitoringConfigured = monitoringEndpoint.apply((v) => v !== undefined);
