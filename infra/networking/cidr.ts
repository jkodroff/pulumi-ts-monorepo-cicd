// Pure TypeScript, no Pulumi imports. Everything here is plain data, which keeps
// the subnet math out of the resource graph and trivially unit-testable.

/**
 * Derive the `netnum`-th subnet of `base`, extending the prefix by `newBits`.
 *
 * cidrSubnet("10.0.0.0/16", 8, 0)   -> "10.0.0.0/24"
 * cidrSubnet("10.0.0.0/16", 8, 128) -> "10.0.128.0/24"
 */
export function cidrSubnet(base: string, newBits: number, netnum: number): string {
    const [ip, prefixStr] = base.split("/");
    const prefix = Number(prefixStr);
    if (!ip || Number.isNaN(prefix)) {
        throw new Error(`cidrSubnet: '${base}' is not a valid CIDR block`);
    }

    const newPrefix = prefix + newBits;
    if (newPrefix > 32) {
        throw new Error(`cidrSubnet: extending ${base} by ${newBits} bits exceeds /32`);
    }
    if (netnum >= 2 ** newBits) {
        throw new Error(`cidrSubnet: netnum ${netnum} does not fit in ${newBits} bits`);
    }

    const octets = ip.split(".").map(Number);
    if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
        throw new Error(`cidrSubnet: '${ip}' is not a valid IPv4 address`);
    }

    const baseInt = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const network = (baseInt & mask) >>> 0;
    const subnet = (network + netnum * 2 ** (32 - newPrefix)) >>> 0;

    const asDotted = [subnet >>> 24, (subnet >>> 16) & 255, (subnet >>> 8) & 255, subnet & 255].join(".");
    return `${asDotted}/${newPrefix}`;
}

/** Name the `i`-th availability zone in a region, AWS-style: us-east-1a, us-east-1b, ... */
export function azName(region: string, i: number): string {
    if (i < 0 || i > 25) {
        throw new Error(`azName: index ${i} is out of range`);
    }
    return `${region}${String.fromCharCode("a".charCodeAt(0) + i)}`;
}
