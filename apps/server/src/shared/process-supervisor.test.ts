import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { superviseProcess } from "./process-supervisor.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("development process supervisor", () => {
  it("restarts a child that exits unexpectedly", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-supervisor-"));
    roots.push(root);
    const marker = join(root, "first-run-complete");
    const launches: number[] = [];
    const childScript = [
      'const { existsSync, writeFileSync } = require("node:fs");',
      `const marker = ${JSON.stringify(marker)};`,
      "if (!existsSync(marker)) {",
      '  writeFileSync(marker, "done");',
      "  process.exit(23);",
      "}",
      "setInterval(() => {}, 1_000);"
    ].join("\n");
    const supervisor = superviseProcess({
      command: process.execPath,
      args: ["-e", childScript],
      cwd: root,
      restartDelayMs: 10,
      onSpawn: child => launches.push(child.pid ?? -1),
      logger: { info: () => {}, error: () => {} }
    });

    try {
      const deadline = Date.now() + 3_000;
      while (launches.length < 2 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      expect(launches).toHaveLength(2);
      expect(launches[0]).not.toBe(launches[1]);
    } finally {
      await supervisor.stop();
    }
  });
});
