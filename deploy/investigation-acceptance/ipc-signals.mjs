// Acceptance-only signal delivery bridge; the production entry and handlers remain unchanged.
// Windows child.kill() force-terminates Node instead of delivering a POSIX signal.
if (typeof process.send !== "function") {
  throw new Error("The synthetic acceptance signal bridge requires a private parent IPC channel.");
}
process.on("message", (message) => {
  if (message?.type !== "synthetic-acceptance-shutdown") return;
  process.disconnect();
  process.emit("SIGTERM", "SIGTERM");
});
// Do not keep a failed startup alive solely because the acceptance control channel exists.
process.channel?.unref();
