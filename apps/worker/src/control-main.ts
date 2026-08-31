import process from "node:process";
import { connectHostControl } from "./service-host/host-control-client.js";
import { runServiceHostRoleEntrypoint } from "./service-host/role-entrypoint.js";

await runServiceHostRoleEntrypoint("control", {
  connect: async (options, signal) => {
    if (options.role !== "control") throw new Error("Control connector received another role.");
    return await connectHostControl(options, signal);
  },
}).catch(() => {
  process.stderr.write(
    '{"component":"worker-control","level":"error","message":"Control payload failed closed during startup."}\n',
  );
  process.exitCode = 1;
});
