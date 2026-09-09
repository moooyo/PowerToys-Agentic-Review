import {
  maximumSchedulingActiveLeases,
  maximumSchedulingQueuedJobs,
} from "@agentic-review/contracts";
import { Form, Input, Switch, Typography } from "antd";
import { parseSchedulingLimit } from "./form";

export function SchedulingLimitFields() {
  const form = Form.useFormInstance();
  const activeUnlimited = Form.useWatch("activeUnlimited", form);
  const queueUnlimited = Form.useWatch("queueUnlimited", form);
  return (
    <>
      <Form.Item
        name="activeUnlimited"
        label="Active leases: unlimited at this scope"
        valuePropName="checked"
      >
        <Switch />
      </Form.Item>
      {!activeUnlimited && (
        <Form.Item
          name="activeLimit"
          label="Maximum active leases"
          required
          rules={[
            {
              validator: async (_, value: string | undefined) => {
                parseSchedulingLimit(
                  value ?? "",
                  maximumSchedulingActiveLeases,
                  "Active lease limit",
                );
              },
            },
          ]}
          extra="Counts leased and running attempts, including cancellation requests and expired leases that have not been reaped."
        >
          <Input inputMode="numeric" maxLength={5} />
        </Form.Item>
      )}
      <Form.Item
        name="queueUnlimited"
        label="Admitted queue: unlimited at this scope"
        valuePropName="checked"
      >
        <Switch />
      </Form.Item>
      {!queueUnlimited && (
        <Form.Item
          name="queueLimit"
          label="Maximum admitted queued jobs"
          required
          rules={[
            {
              validator: async (_, value: string | undefined) => {
                parseSchedulingLimit(
                  value ?? "",
                  maximumSchedulingQueuedJobs,
                  "Admitted queue limit",
                );
              },
            },
          ]}
          extra="Counts admitted jobs waiting to start or retry. Accepted jobs awaiting admission remain saved and cancellable."
        >
          <Input inputMode="numeric" maxLength={7} />
        </Form.Item>
      )}
      <Typography.Paragraph type="secondary">
        Lowering a limit below current usage is allowed. Existing work continues; new admission or
        lease grants wait for capacity. Queue limits do not cap accepted job records, storage, or
        spending.
      </Typography.Paragraph>
    </>
  );
}
