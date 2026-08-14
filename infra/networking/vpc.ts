import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

import { azName, cidrSubnet } from "./cidr";

export interface SubnetArgs {
    vpcId: pulumi.Input<string>;
    cidrBlock: string;
    availabilityZone: string;
    tier: "public" | "private";
}

/**
 * A stand-in for a real cloud subnet. The only resource underneath is a RandomId,
 * which gives us a stable synthetic ID with no credentials and nothing to bill.
 */
export class Subnet extends pulumi.ComponentResource {
    public readonly subnetId: pulumi.Output<string>;
    public readonly cidrBlock: string;
    public readonly availabilityZone: string;
    public readonly tier: "public" | "private";

    constructor(name: string, args: SubnetArgs, opts?: pulumi.ComponentResourceOptions) {
        super("monorepo:networking:Subnet", name, {}, opts);

        // `keepers` is what makes this behave like real infrastructure: change the CIDR
        // or the AZ in stack config and the ID is replaced, so `pulumi preview` shows a
        // genuine diff between the dev and prod stacks instead of a no-op.
        const id = new random.RandomId(name, {
            byteLength: 8,
            keepers: {
                cidrBlock: args.cidrBlock,
                availabilityZone: args.availabilityZone,
                tier: args.tier,
            },
        }, { parent: this });

        this.subnetId = pulumi.interpolate`subnet-${id.hex}`;
        this.cidrBlock = args.cidrBlock;
        this.availabilityZone = args.availabilityZone;
        this.tier = args.tier;

        this.registerOutputs({
            subnetId: this.subnetId,
            cidrBlock: this.cidrBlock,
            availabilityZone: this.availabilityZone,
        });
    }
}

export interface VpcArgs {
    cidrBlock: string;
    azCount: number;
    subnetNewBits: number;
    region: string;
}

/**
 * A stand-in for a real VPC: one synthetic ID plus a public and a private subnet
 * per availability zone, with CIDRs carved out of the VPC block by pure TS math.
 */
export class Vpc extends pulumi.ComponentResource {
    public readonly vpcId: pulumi.Output<string>;
    public readonly cidrBlock: string;
    public readonly availabilityZones: string[];
    public readonly publicSubnets: Subnet[];
    public readonly privateSubnets: Subnet[];

    constructor(name: string, args: VpcArgs, opts?: pulumi.ComponentResourceOptions) {
        super("monorepo:networking:Vpc", name, {}, opts);

        const id = new random.RandomId(name, {
            byteLength: 8,
            keepers: { cidrBlock: args.cidrBlock, region: args.region },
        }, { parent: this });

        this.vpcId = pulumi.interpolate`vpc-${id.hex}`;
        this.cidrBlock = args.cidrBlock;
        this.availabilityZones = Array.from({ length: args.azCount }, (_, i) => azName(args.region, i));

        // Public subnets start at netnum 0, private at 128, so a /16 with 8 new bits
        // reads as 10.0.0.0/24, 10.0.1.0/24, ... for public and 10.0.128.0/24, ... for private.
        this.publicSubnets = this.availabilityZones.map((az, i) => new Subnet(`${name}-public-${i}`, {
            vpcId: this.vpcId,
            cidrBlock: cidrSubnet(args.cidrBlock, args.subnetNewBits, i),
            availabilityZone: az,
            tier: "public",
        }, { parent: this }));

        this.privateSubnets = this.availabilityZones.map((az, i) => new Subnet(`${name}-private-${i}`, {
            vpcId: this.vpcId,
            cidrBlock: cidrSubnet(args.cidrBlock, args.subnetNewBits, 128 + i),
            availabilityZone: az,
            tier: "private",
        }, { parent: this }));

        this.registerOutputs({
            vpcId: this.vpcId,
            cidrBlock: this.cidrBlock,
            availabilityZones: this.availabilityZones,
        });
    }
}
