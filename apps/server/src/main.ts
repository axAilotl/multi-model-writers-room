import { startRuntime } from "./runtime.js";

const runtime = await startRuntime();
const address = runtime.address();
if (!address) throw new Error("Writers' Room server failed to bind");
console.log(`Writers' Room listening on http://${address.address}:${address.port}`);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await runtime.close();
}

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
