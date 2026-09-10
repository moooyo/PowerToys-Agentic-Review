import { Dialog, DialogContent, DialogTitle, Stack, Typography } from "@mui/material";
import { createContext, type ReactNode, useContext, useState } from "react";
import { nextConfigurationScopeState } from "./state";

const ConfigurationAvailable = createContext(false);

export function useConfigurationAvailable(): boolean {
  return useContext(ConfigurationAvailable);
}

export function ConfigurationScopeGuard({
  scopeKey,
  available,
  fallback,
  children,
}: {
  scopeKey: string;
  available: boolean;
  fallback: ReactNode;
  children: ReactNode;
}) {
  const [state, setState] = useState({ scopeKey, wasVerified: available });
  const nextState = nextConfigurationScopeState(state, scopeKey, available);
  if (nextState !== state) setState(nextState);

  if (!nextState.wasVerified) return fallback;

  return (
    <ConfigurationAvailable.Provider value={available}>
      {children}
      <Dialog
        open={!available}
        onClose={() => {
          // Only repository confirmation can unlock the preserved editors.
        }}
        fullWidth
        maxWidth="sm"
        aria-labelledby="configuration-scope-guard-title"
        sx={{ zIndex: 3000 }}
      >
        <DialogTitle id="configuration-scope-guard-title">
          Repository confirmation is unavailable
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Typography>
              Your open editors and unsaved changes are preserved. Confirm this repository again to
              continue. Choosing a different repository closes these editors.
            </Typography>
            {fallback}
          </Stack>
        </DialogContent>
      </Dialog>
    </ConfigurationAvailable.Provider>
  );
}
