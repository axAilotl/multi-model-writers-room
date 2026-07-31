import { spawn } from "node:child_process";

const port = 5199;
const origin = `http://127.0.0.1:${port}`;
const output = [];
const server = spawn(
  "npm",
  [
    "run",
    "dev",
    "-w",
    "@writers-room/web",
    "--",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort"
  ],
  {
    cwd: new URL("..", import.meta.url),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  }
);

server.stdout.on("data", chunk => output.push(chunk.toString()));
server.stderr.on("data", chunk => output.push(chunk.toString()));

try {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let entry;
    try {
      entry = await fetch(`${origin}/src/main.tsx`);
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 50));
      continue;
    }
    if (!entry.ok) {
      throw new Error(
        `browser entry returned HTTP ${entry.status}\n${output.join("")}`
      );
    }
    const source = await entry.text();
    if (!source.includes("createRoot")) {
      throw new Error("browser entry was not transformed");
    }
    console.log("Web dev-server browser entry transformed successfully.");
    lastError = undefined;
    break;
  }
  if (lastError) {
    throw new Error(
      `${lastError instanceof Error ? lastError.message : String(lastError)}\n${output.join("")}`
    );
  }
} finally {
  if (server.pid !== undefined) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      // The process already exited.
    }
  }
}
