import type { JobAdmission as Admission } from "@agentic-review/contracts";
import { Descriptions, Space, Tag, Typography } from "antd";

export function JobAdmission({ admission }: { admission: Admission | null }) {
  if (!admission) return null;
  const migrated = admission.timestampBasis === "migration_backfill";
  return (
    <Space orientation="vertical" size="small" style={{ width: "100%" }}>
      <Typography.Text>
        {admission.state === "pending"
          ? "This execution is saved and is waiting to enter the queue. No new attempt has started."
          : "This execution is queued. Worker availability and any recorded retry backoff still apply."}
      </Typography.Text>
      {migrated && (
        <Space>
          <Tag>Migration record</Tag>
          <Typography.Text type="secondary">
            These timestamps were recorded during migration; the original queue entry time was not
            retained.
          </Typography.Text>
        </Space>
      )}
      <Descriptions
        size="small"
        column={1}
        items={[
          {
            key: "requested",
            label: migrated ? "Migration request timestamp" : "Admission requested",
            children: (
              <time dateTime={admission.requestedAt}>
                {new Date(admission.requestedAt).toLocaleString("en-US")}
              </time>
            ),
          },
          ...(admission.state === "admitted"
            ? [
                {
                  key: "admitted",
                  label: migrated ? "Migration admission timestamp" : "Entered queue",
                  children: (
                    <time dateTime={admission.admittedAt}>
                      {new Date(admission.admittedAt).toLocaleString("en-US")}
                    </time>
                  ),
                },
              ]
            : []),
        ]}
      />
    </Space>
  );
}
