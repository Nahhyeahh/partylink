// Getting an emulator ready on this PC: Microsoft's runtime check, then a
// one-time download. Shared by everything that starts games.
import { useEffect, useState } from "react";
import { desktop, type InstallProgress } from "./desktop";
import type { EmulatorRelease } from "./emulators";

export type EmulatorSetup =
  | { status: "checking" }
  | { status: "needs-runtime" }
  | { status: "installing"; progress: InstallProgress | null }
  | { status: "ready" }
  | { status: "error"; message: string };

export function errorText(error: unknown): string {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "Something went wrong.";
}

// One install per release, even if several screens ask at once.
const installs = new Map<string, Promise<void>>();

function install(release: EmulatorRelease): Promise<void> {
  const key = `${release.emulator}@${release.tag}`;
  let pending = installs.get(key);
  if (!pending) {
    pending = desktop.installEmulator(release).finally(() => installs.delete(key));
    installs.set(key, pending);
  }
  return pending;
}

export function useEmulatorSetup(release: EmulatorRelease | null): { setup: EmulatorSetup; retry: () => void } {
  const [setup, setSetup] = useState<EmulatorSetup>({ status: "checking" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!release) return;
    let cancelled = false;
    let unlisten: () => void = () => {};
    const update = (next: EmulatorSetup) => !cancelled && setSetup(next);

    (async () => {
      update({ status: "checking" });
      try {
        if (release.emulator === "dolphin-mpn" && (await desktop.needsVcRuntime())) {
          update({ status: "needs-runtime" });
          return;
        }
        if (await desktop.emulatorInstalled(release)) {
          update({ status: "ready" });
          return;
        }
        update({ status: "installing", progress: null });
        unlisten = await desktop.onInstallProgress((progress) => {
          if (progress.emulator === release.emulator) update({ status: "installing", progress });
        });
        await install(release);
        update({ status: "ready" });
      } catch (error) {
        update({ status: "error", message: errorText(error) });
      } finally {
        unlisten();
      }
    })();

    return () => {
      cancelled = true;
      unlisten();
    };
  }, [release, attempt]);

  return { setup, retry: () => setAttempt((n) => n + 1) };
}
