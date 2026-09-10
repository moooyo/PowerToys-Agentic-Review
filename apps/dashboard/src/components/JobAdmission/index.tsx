import type { JobAdmission as Admission } from "@agentic-review/contracts";
import { Chip, Stack, Typography } from "@mui/material";
import { DetailsGrid } from "@/components/ui";

export function JobAdmission({ admission }: { admission: Admission | null }) {
  if (!admission) return null;
  const migrated = admission.timestampBasis === "migration_backfill";
  return (
    <Stack spacing={2} sx={{ width: "100%", py: 1 }}>
      <Typography variant="body2">
        {admission.state === "pending"
          ? "This execution is saved and is waiting to enter the queue. No new attempt has started."
          : "This execution is queued. Worker availability and any recorded retry backoff still apply."}
      </Typography>
      {migrated && (
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={1}
          sx={{ alignItems: "flex-start" }}
        >
          <Chip label="Migration record" variant="outlined" />
          <Typography variant="body2" color="text.secondary">
            These timestamps were recorded during migration; the original queue entry time was not
            retained.
          </Typography>
        </Stack>
      )}
      <DetailsGrid
        columns={2}
        items={[
          {
            key: "requested",
            label: migrated ? "Migration request timestamp" : "Admission requested",
            value: (
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
                  value: (
                    <time dateTime={admission.admittedAt}>
                      {new Date(admission.admittedAt).toLocaleString("en-US")}
                    </time>
                  ),
                },
              ]
            : []),
        ]}
      />
    </Stack>
  );
}
