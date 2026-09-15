import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const port = process.argv[2] ?? "3000";
const statusPath = join(tmpdir(), `kabutora-test-backend-${port}.json`);
const state = { failed: false, message: "", stopping: false };
const record = () => writeFileSync(statusPath, JSON.stringify(state));
record();
const webRoot = fileURLToPath(new URL("../apps/web/", import.meta.url));
const child = spawn(process.execPath, [join(webRoot, "node_modules/next/dist/bin/next"), "dev", "--port", port], { cwd: webRoot, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
const fatal = /\[ERROR\]|SQLITE_(?:IOERR|BUSY|LOCKED|CANTOPEN)|uncaughtException|unhandledRejection|FATAL|workerd.*(?:failed|fatal)/iu;
const stop = () => {
  state.stopping = true; record();
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch (error) { if (error.code !== "ESRCH") throw error; }
};
for (const stream of [child.stdout, child.stderr]) {
  let remainder = "";
  stream.on("data", (chunk) => {
    process.stdout.write(chunk);
    const lines = (remainder + chunk.toString()).split("\n");
    remainder = lines.pop() ?? "";
    for (const line of lines) if (fatal.test(line)) {
      state.failed = true; state.message = line.slice(0, 1000); record(); stop();
    }
  });
}
child.on("error", (error) => { state.failed = true; state.message = error.message; record(); process.exitCode = 1; });
child.on("exit", (code, signal) => {
  if (!state.stopping) { state.failed = true; state.message = `Backend exited: ${code ?? signal}`; record(); }
  process.exitCode = state.failed ? 1 : 0;
});
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("exit", () => { if (child.exitCode === null) stop(); });
