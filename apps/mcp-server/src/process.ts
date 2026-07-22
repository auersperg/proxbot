import { existsSync } from "node:fs";

import { ProxbotError } from "./errors.ts";

export async function runJsonCommand(
  executable: string,
  arguments_: readonly string[],
  timeoutMs: number,
): Promise<unknown> {
  if (!existsSync(executable)) {
    throw new ProxbotError(
      "PROVIDER_UNAVAILABLE",
      `Executable does not exist: ${executable}`,
    );
  }
  const process = Bun.spawn([executable, ...arguments_], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: Bun.env.PATH ?? "",
      HOME: Bun.env.HOME ?? "",
      TMPDIR: Bun.env.TMPDIR ?? "",
      LANG: Bun.env.LANG ?? "en_US.UTF-8",
    },
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    process.kill();
  }, timeoutMs);
  try {
    const [status, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (timedOut) {
      throw new ProxbotError("TIMEOUT", "proxbot subprocess timed out", { timeoutMs });
    }
    if (status !== 0) {
      throw new ProxbotError("INTERNAL", "proxbot subprocess failed", {
        status,
        stderr: stderr.trim().slice(0, 4_096),
      });
    }
    try {
      return JSON.parse(stdout);
    } catch (error) {
      throw new ProxbotError(
        "INTERNAL",
        "proxbot subprocess returned invalid JSON",
        { stdoutBytes: Buffer.byteLength(stdout) },
        { cause: error },
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}
