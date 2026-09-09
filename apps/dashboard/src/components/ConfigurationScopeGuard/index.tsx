import { Modal, Typography } from "antd";
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
      <Modal
        open={!available}
        title="Repository confirmation is unavailable"
        closable={false}
        mask={{ closable: false }}
        keyboard={false}
        footer={null}
        zIndex={3000}
        destroyOnHidden
      >
        <Typography.Paragraph>
          Your open editors and unsaved changes are preserved. Confirm this repository again to
          continue. Choosing a different repository closes these editors.
        </Typography.Paragraph>
        {fallback}
      </Modal>
    </ConfigurationAvailable.Provider>
  );
}
