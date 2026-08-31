import process from "node:process";
import { connectExecutorHostControl } from "./service-host/executor-host-control-session.js";
import { runServiceHostRoleEntrypoint } from "./service-host/role-entrypoint.js";

await runServiceHostRoleEntrypoint("executor", {
  connect: async (options, signal) => {
    if (options.role !== "executor") throw new Error("Executor connector received another role.");
    return await connectExecutorHostControl(options, signal);
  },
}).catch(() => {
  process.stderr.write(
    '{"component":"worker-executor","level":"error","message":"Executor payload failed closed during startup."}\n',
  );
  process.exitCode = 1;
});
