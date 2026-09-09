import { useConfigurationAvailable } from "@/components/ConfigurationScopeGuard";
import { useOperatorAccess } from "@/components/OperatorAccess";

export function usePromptAvailable(): boolean {
  const configurationAvailable = useConfigurationAvailable();
  const access = useOperatorAccess();
  return (
    configurationAvailable &&
    access.ready &&
    !access.checking &&
    !access.error &&
    access.platformAdministrator
  );
}
