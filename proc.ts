import { spawn } from "child_process";
import { Retryable, BackOffPolicy } from "typescript-retry-decorator";

function exec(command: string, args: string[]) {
  return new Promise<{
    stdout: string;
    stderr: string;
    status: number | null;
  }>((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("exit", (status) => resolve({ stdout, stderr, status }));
  });
}

export class Proc {
  @Retryable({
    maxAttempts: 3,
    backOffPolicy: BackOffPolicy.FixedBackOffPolicy,
    backOff: 1000,
  })
  static async createFace(dest: string): Promise<number> {
    const res = await exec("nfdc", [
      "face",
      "create",
      "remote",
      `udp4://${dest}:6363`,
      "persistency",
      "permanent",
    ]);

    if (res.status !== 0) {
      throw new Error(`Failed to create face to ${dest}: ${res.stderr}`);
    }

    const faceid = res.stdout
      .split(" ")
      .find((x) => x.startsWith("id="))
      ?.split("=")[1];
    if (!faceid) {
      throw new Error(`Failed to parse face id: ${res.stdout}`);
    }

    return parseInt(faceid);
  }

  @Retryable({
    maxAttempts: 3,
    backOffPolicy: BackOffPolicy.FixedBackOffPolicy,
    backOff: 1000,
  })
  static async setStrategy(prefix: string, strategy: string) {
    const res = await exec("nfdc", [
      "strategy",
      "set",
      "prefix",
      prefix,
      "strategy",
      strategy,
    ]);

    if (res.status !== 0) {
      throw new Error(`Failed to set strategy for ${prefix}: ${res.stderr}`);
    }
  }

  @Retryable({
    maxAttempts: 3,
    backOffPolicy: BackOffPolicy.FixedBackOffPolicy,
    backOff: 1000,
  })
  static async addRoute(prefix: string, faceid: number, cost: number = 1) {
    const res = await exec("nfdc", [
      "route",
      "add",
      "prefix",
      prefix,
      "nexthop",
      faceid.toFixed(0),
      "cost",
      cost.toFixed(0),
    ]);

    if (res.status !== 0) {
      throw new Error(
        `Failed to add route to ${prefix} from ${faceid}: ${res.stderr}`
      );
    }
  }

  @Retryable({
    maxAttempts: 3,
    backOffPolicy: BackOffPolicy.FixedBackOffPolicy,
    backOff: 1000,
  })
  static async removeRoute(prefix: string, nexthop: number) {
    const res = await exec("nfdc", [
      "route",
      "remove",
      "prefix",
      prefix,
      "nexthop",
      nexthop.toFixed(0),
    ]);

    if (res.status !== 0) {
      throw new Error(`Failed to remove route to ${prefix}: ${res.stderr}`);
    }
  }
}
