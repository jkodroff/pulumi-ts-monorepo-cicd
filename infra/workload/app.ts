import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

export interface FakeAppArgs {
    /** Secret, read from monorepo-cluster over a StackReference. */
    kubeconfig: pulumi.Input<string>;
    clusterName: pulumi.Input<string>;
    appName: string;
    replicas: number;
    dbPasswordLength: number;
}

/** A fake application release: a name, an endpoint, and a generated DB credential. */
export class FakeApp extends pulumi.ComponentResource {
    public readonly releaseName: pulumi.Output<string>;
    public readonly endpoint: pulumi.Output<string>;
    public readonly dbPassword: pulumi.Output<string>;
    public readonly replicas: number;
    /** Parsed out of the kubeconfig — proof the upstream secret arrived intact. Still secret. */
    public readonly kubeconfigContext: pulumi.Output<string>;

    constructor(name: string, args: FakeAppArgs, opts?: pulumi.ComponentResourceOptions) {
        super("monorepo:workload:FakeApp", name, {}, opts);

        const pet = new random.RandomPet(name, {
            length: 2,
            prefix: args.appName,
            keepers: { appName: args.appName },
        }, { parent: this });

        // RandomPassword marks `.result` secret via additionalSecretOutputs.
        const dbPassword = new random.RandomPassword(`${name}-db`, {
            length: args.dbPasswordLength,
            special: true,
            overrideSpecial: "!#$%*()-_=+[]{}<>:?",
        }, { parent: this });

        this.releaseName = pet.id;
        this.dbPassword = dbPassword.result;
        this.replicas = args.replicas;
        this.endpoint = pulumi.interpolate`https://${pet.id}.${args.clusterName}.svc.local`;

        // A real app would hand the kubeconfig to a Kubernetes provider. Here we only read
        // the context name out of it: enough to prove the secret arrived intact across the
        // StackReference, without writing the credential itself into this stack's outputs.
        // The apply is over a secret, so the result is secret too.
        this.kubeconfigContext = pulumi
            .output(args.kubeconfig)
            .apply((kc) => JSON.parse(kc)["current-context"] as string);

        this.registerOutputs({
            releaseName: this.releaseName,
            endpoint: this.endpoint,
        });
    }
}
