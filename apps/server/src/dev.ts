import { superviseProcess } from "./shared/process-supervisor.js";

const supervisor = superviseProcess({
  command: process.execPath,
  args: ["--import", "tsx", "src/main.ts"],
  cwd: process.cwd(),
  watchPaths: ["src"]
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  void supervisor.stop().finally(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
