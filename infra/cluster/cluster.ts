import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import * as tls from "@pulumi/tls";

export interface NodeGroupArgs {
    clusterName: pulumi.Input<string>;
    subnetIds: pulumi.Input<string[]>;
    nodeCount: number;
    nodeSize: string;
}

/** A stand-in for a managed node pool sitting in the private subnets of layer 1. */
export class NodeGroup extends pulumi.ComponentResource {
    public readonly nodeGroupName: pulumi.Output<string>;
    public readonly nodeCount: number;
    public readonly nodeSize: string;

    constructor(name: string, args: NodeGroupArgs, opts?: pulumi.ComponentResourceOptions) {
        super("monorepo:cluster:NodeGroup", name, {}, opts);

        const id = new random.RandomId(name, {
            byteLength: 6,
            keepers: { nodeCount: String(args.nodeCount), nodeSize: args.nodeSize },
        }, { parent: this });

        this.nodeGroupName = pulumi.interpolate`ng-${args.nodeSize}-${id.hex}`;
        this.nodeCount = args.nodeCount;
        this.nodeSize = args.nodeSize;

        this.registerOutputs({ nodeGroupName: this.nodeGroupName });
    }
}

export interface ClusterArgs {
    vpcId: pulumi.Input<string>;
    subnetIds: pulumi.Input<string[]>;
    availabilityZones: pulumi.Input<string[]>;
    k8sVersion: string;
    nodeCount: number;
    nodeSize: string;
}

/**
 * A stand-in for a managed Kubernetes cluster. The interesting part is the kubeconfig:
 * it is assembled from a real self-signed CA (via @pulumi/tls) so that this program has
 * a genuine *secret* output to hand downstream, without any cloud provider involved.
 */
export class Cluster extends pulumi.ComponentResource {
    public readonly clusterName: pulumi.Output<string>;
    public readonly endpoint: pulumi.Output<string>;
    public readonly kubeconfig: pulumi.Output<string>;
    public readonly caCertPem: pulumi.Output<string>;
    public readonly nodeGroup: NodeGroup;

    constructor(name: string, args: ClusterArgs, opts?: pulumi.ComponentResourceOptions) {
        super("monorepo:cluster:Cluster", name, {}, opts);

        const pet = new random.RandomPet(name, {
            length: 2,
            keepers: { k8sVersion: args.k8sVersion },
        }, { parent: this });

        // RandomPet has no `.result` — the generated name IS the resource ID.
        this.clusterName = pet.id;
        this.endpoint = pulumi.interpolate`https://${pet.id}.k8s.local:6443`;

        // @pulumi/tls already marks privateKeyPem as secret via additionalSecretOutputs,
        // so anything derived from it downstream inherits that taint automatically.
        const caKey = new tls.PrivateKey(`${name}-ca-key`, {
            algorithm: "ECDSA",
            ecdsaCurve: "P256",
        }, { parent: this });

        const ca = new tls.SelfSignedCert(`${name}-ca`, {
            privateKeyPem: caKey.privateKeyPem,
            isCaCertificate: true,
            allowedUses: ["cert_signing", "crl_signing", "digital_signature"],
            validityPeriodHours: 24 * 365,
            subject: {
                commonName: pulumi.interpolate`${pet.id}.k8s.local`,
                organization: "monorepo-demo",
            },
        }, { parent: this });

        // certPem is deliberately NOT secret. Exporting it alongside the kubeconfig gives
        // a plaintext/secret contrast in `pulumi stack output`.
        this.caCertPem = ca.certPem;

        this.nodeGroup = new NodeGroup(`${name}-nodes`, {
            clusterName: this.clusterName,
            subnetIds: args.subnetIds,
            nodeCount: args.nodeCount,
            nodeSize: args.nodeSize,
        }, { parent: this });

        // JSON is valid YAML, so a JSON kubeconfig is a real kubeconfig — and it saves
        // pulling in a YAML serializer just for the demo.
        const kubeconfigJson = pulumi
            .all([this.clusterName, this.endpoint, ca.certPem, caKey.privateKeyPem])
            .apply(([cn, endpoint, certPem, keyPem]) => JSON.stringify({
                apiVersion: "v1",
                kind: "Config",
                clusters: [{
                    name: cn,
                    cluster: { server: endpoint, "certificate-authority-data": b64(certPem) },
                }],
                users: [{
                    name: cn,
                    user: {
                        "client-certificate-data": b64(certPem),
                        "client-key-data": b64(keyPem),
                    },
                }],
                contexts: [{ name: cn, context: { cluster: cn, user: cn } }],
                "current-context": cn,
            }, null, 2));

        // Belt and braces: the apply above already inherits the secret taint from
        // caKey.privateKeyPem. pulumi.secret() is here because it is the explicit,
        // readable way to say "this output is a secret" and does not depend on the
        // reader knowing what @pulumi/tls marks internally.
        this.kubeconfig = pulumi.secret(kubeconfigJson);

        this.registerOutputs({
            clusterName: this.clusterName,
            endpoint: this.endpoint,
            kubeconfig: this.kubeconfig,
        });
    }
}

function b64(s: string): string {
    return Buffer.from(s, "utf8").toString("base64");
}
