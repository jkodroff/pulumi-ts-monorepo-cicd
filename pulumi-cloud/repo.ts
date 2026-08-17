import { execFileSync } from "child_process";

// Matches the three shapes `git remote origin` takes for a GitHub repo:
//
//   git@github.com:owner/repo.git
//   https://github.com/owner/repo.git         (optionally with a token: https://x:y@github.com/...)
//   ssh://git@github.com/owner/repo.git
//
// The trailing `.git` is optional in all three.
const REMOTE = /^(?:git@github\.com:|(?:https?|ssh):\/\/(?:[^@/]+@)?github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/;

/**
 * The `owner/repo` this working copy came from.
 *
 * Reading it from git rather than hardcoding it is what makes a fork work with no edits:
 * clone, rename, `pulumi up`, and the deployment settings point at the new repo. The
 * `repository` config key stays available as the explicit override, for the case where
 * the checkout has no origin (a tarball, say) or points somewhere other than the repo
 * being configured.
 */
export function repoFromGitRemote(configKey: string): string {
    let url: string;
    try {
        url = execFileSync("git", ["config", "--get", "remote.origin.url"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        throw new Error(
            `could not read 'git remote origin' to infer the GitHub repository. ` +
                `Set it explicitly: pulumi config set ${configKey} owner/repo`,
        );
    }

    const match = REMOTE.exec(url);
    if (!match) {
        throw new Error(
            `git remote origin '${url}' is not a recognizable GitHub URL. ` +
                `Set the repository explicitly: pulumi config set ${configKey} owner/repo`,
        );
    }

    return match[1];
}
