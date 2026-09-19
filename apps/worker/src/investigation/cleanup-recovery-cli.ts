import { userInfo } from "node:os";
import { win32 } from "node:path";
import type { Logger } from "../logging/logger.js";
import { InvestigationAttemptCleanupJournal } from "./attempt-cleanup-journal.js";
import { createInvestigationExecutionRuntime } from "./runtime.js";
import type { InvestigationWorkerRuntimeConfig } from "./runtime-config.js";

export type CleanupRecoveryCommand =
  | { readonly kind: "list" }
  | {
      readonly kind: "confirm";
      readonly attemptId: string;
      readonly desktopRestored: true;
      readonly ownedProcessTreeStopped: boolean;
      readonly reason: string;
    };

export function parseCleanupRecoveryCommand(
  args: readonly string[],
): CleanupRecoveryCommand | null {
  if (args[0] !== "cleanup-recovery") return null;
  if (args.length === 2 && args[1] === "list") return { kind: "list" };
  if (args[1] !== "confirm" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(args[2] ?? ""))
    throw new Error(
      "Use cleanup-recovery list or cleanup-recovery confirm <attempt-id> --desktop-restored --reason <observation>.",
    );
  let desktopRestored = false;
  let ownedProcessTreeStopped = false;
  let reason: string | undefined;
  for (let index = 3; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--desktop-restored" && !desktopRestored) desktopRestored = true;
    else if (flag === "--owned-process-tree-stopped" && !ownedProcessTreeStopped)
      ownedProcessTreeStopped = true;
    else if (flag === "--reason" && reason === undefined) reason = args[++index];
    else throw new Error("The cleanup recovery command contains an unknown or repeated argument.");
  }
  if (
    !desktopRestored ||
    reason === undefined ||
    reason.trim().length === 0 ||
    reason.length > 2_048 ||
    /[\0\r\n]/u.test(reason)
  )
    throw new Error(
      "Recovery requires a restored-desktop confirmation and a concrete observation in --reason.",
    );
  return {
    kind: "confirm",
    attemptId: args[2]!,
    desktopRestored: true,
    ownedProcessTreeStopped,
    reason,
  };
}

/** No command accepts lease credentials; recovery reads the original private fsynced identity. */
export async function runCleanupRecoveryCommand(
  config: InvestigationWorkerRuntimeConfig,
  command: CleanupRecoveryCommand,
  logger: Logger,
  output: (text: string) => void = (text) => {
    process.stdout.write(text);
  },
): Promise<boolean> {
  if (command.kind === "list") {
    const journal = new InvestigationAttemptCleanupJournal({
      directory: win32.join(config.dataDirectory, "attempt-cleanup"),
    });
    output(`${JSON.stringify(await journal.statuses(), null, 2)}\n`);
    return true;
  }
  // Starting a separate ProcessHost acquires the same native instance mutex. A live Worker
  // prevents this dedicated recovery runtime from replacing its active process ownership.
  const runtime = await createInvestigationExecutionRuntime(config, logger);
  try {
    const statuses = await runtime.confirmCleanupRecovery(command.attemptId, {
      operator: userInfo().username,
      reason: command.reason,
      desktopRestored: true,
      ownedProcessTreeStopped: command.ownedProcessTreeStopped,
    });
    const selected = statuses.filter((entry) => entry.attemptId === command.attemptId);
    output(`${JSON.stringify(selected, null, 2)}\n`);
    return selected.length === 1 && selected[0]!.state === "acknowledged";
  } finally {
    await runtime.stop();
  }
}
