// Loaded only by the production supervisor through its private Node IPC channel.
// Windows child.kill() does not deliver a cooperative POSIX signal to Node.
if (typeof process.send !== "function") {
  throw new Error("The operations shutdown bridge requires a parent IPC channel.");
}

let requested = false;
let delivered = false;
const deliver = () => {
  // Worker initialization is asynchronous and installs its handler after startup.
  if (!requested || delivered || process.listenerCount("SIGTERM") === 0) return;
  delivered = true;
  clearInterval(pending);
  process.emit("SIGTERM", "SIGTERM");
};
const pending = setInterval(deliver, 50);
pending.unref();
process.on("message", (message) => {
  if (message?.type !== "agentic-review-operations-shutdown-v1") return;
  requested = true;
  deliver();
});
process.on("disconnect", () => {
  requested = true;
  deliver();
});
// A failed startup must be able to exit without waiting for its parent.
process.channel?.unref();
