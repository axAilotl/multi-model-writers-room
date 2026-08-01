import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";

interface SupervisorLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface ProcessSupervisor {
  restart(): void;
  stop(): Promise<void>;
}

export function superviseProcess(options: {
  command: string;
  args?: string[];
  cwd: string;
  watchPaths?: string[];
  restartDelayMs?: number;
  onSpawn?: (child: ChildProcess) => void;
  logger?: SupervisorLogger;
  spawnOptions?: Omit<SpawnOptions, "cwd">;
}): ProcessSupervisor {
  const logger = options.logger ?? console;
  const restartDelayMs = options.restartDelayMs ?? 250;
  let child: ChildProcess | undefined;
  let restartTimer: NodeJS.Timeout | undefined;
  let fileChangeTimer: NodeJS.Timeout | undefined;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  const watchers: FSWatcher[] = [];
  const plannedRestarts = new WeakSet<ChildProcess>();

  function scheduleLaunch(delayMs = restartDelayMs): void {
    if (stopping) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(launch, delayMs);
  }

  function launch(): void {
    if (stopping) return;
    const launched = spawn(options.command, options.args ?? [], {
      stdio: "inherit",
      ...options.spawnOptions,
      cwd: options.cwd
    });
    child = launched;
    options.onSpawn?.(launched);
    launched.once("error", error => {
      logger.error(`[server-supervisor] Failed to start child: ${error.message}`);
    });
    launched.once("exit", (code, signal) => {
      if (child === launched) child = undefined;
      if (stopping) return;
      if (!plannedRestarts.has(launched)) {
        logger.error(
          `[server-supervisor] Child exited unexpectedly ` +
          `(code ${code ?? "none"}, signal ${signal ?? "none"}); restarting.`
        );
      }
      scheduleLaunch();
    });
  }

  function restart(): void {
    if (stopping) return;
    clearTimeout(fileChangeTimer);
    fileChangeTimer = setTimeout(() => {
      const active = child;
      if (active && active.exitCode === null && active.signalCode === null) {
        logger.info("[server-supervisor] Source changed; restarting server.");
        plannedRestarts.add(active);
        const forceTimer = setTimeout(() => {
          if (active.exitCode === null && active.signalCode === null) {
            active.kill("SIGKILL");
          }
        }, 2_000);
        active.once("exit", () => clearTimeout(forceTimer));
        active.kill("SIGTERM");
      } else {
        scheduleLaunch(0);
      }
    }, 100);
  }

  for (const watchPath of options.watchPaths ?? []) {
    try {
      watchers.push(watch(resolve(options.cwd, watchPath), {
        recursive: true
      }, (_eventType, filename) => {
        if (filename && !/\.(?:ts|tsx|js|mjs|json)$/i.test(filename)) return;
        restart();
      }));
    } catch (error) {
      logger.error(
        `[server-supervisor] Could not watch ${watchPath}: ` +
        (error instanceof Error ? error.message : String(error))
      );
    }
  }

  launch();

  return {
    restart,
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopping = true;
      clearTimeout(restartTimer);
      clearTimeout(fileChangeTimer);
      for (const watcher of watchers) watcher.close();
      const active = child;
      if (!active || active.exitCode !== null || active.signalCode !== null) {
        stopPromise = Promise.resolve();
        return stopPromise;
      }
      stopPromise = new Promise(resolveStop => {
        const forceTimer = setTimeout(() => active.kill("SIGKILL"), 2_000);
        active.once("exit", () => {
          clearTimeout(forceTimer);
          resolveStop();
        });
        active.kill("SIGTERM");
      });
      return stopPromise;
    }
  };
}
