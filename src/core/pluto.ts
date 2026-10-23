import { spawn } from "node:child_process";

export function runPluto(
  runtime: string,
  scriptPath: string,
  workingDirectory: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime, [scriptPath], {
      cwd: workingDirectory,
      env,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Unable to start Pluto runtime: ${runtime}`, { cause: error }));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Pluto script timed out after ${timeoutMs}ms: ${scriptPath}`));
      } else if (code !== 0) {
        reject(new Error(
          `Pluto script failed (exit=${String(code)}, signal=${String(signal)}): ${scriptPath}`
          + (stderr ? `\n${stderr}` : ""),
        ));
      } else {
        resolve();
      }
    });
  });
}
