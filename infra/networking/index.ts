import * as pulumi from "@pulumi/pulumi";

import { Vpc } from "./vpc";

// `new pulumi.Config()` with no argument namespaces to the project name, so these
// resolve against the `monorepo-networking:` keys in Pulumi.<stack>.yaml.
const cfg = new pulumi.Config();

const vpc = new Vpc("main", {
    cidrBlock: cfg.require("cidrBlock"),
    azCount: cfg.requireNumber("azCount"),
    subnetNewBits: cfg.requireNumber("subnetNewBits"),
    region: cfg.require("region"),
});

// Layer 1 is the bottom of the stack: it exports, and consumes nothing.
// Everything below is read by monorepo-cluster via a StackReference.
export const vpcId = vpc.vpcId;
export const cidrBlock = vpc.cidrBlock;
export const availabilityZones = vpc.availabilityZones;
export const publicSubnetIds = pulumi.all(vpc.publicSubnets.map((s) => s.subnetId));
export const privateSubnetIds = pulumi.all(vpc.privateSubnets.map((s) => s.subnetId));
export const publicSubnetCidrs = vpc.publicSubnets.map((s) => s.cidrBlock);
export const privateSubnetCidrs = vpc.privateSubnets.map((s) => s.cidrBlock);
