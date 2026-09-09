import type { ConfigurationAuditAdapter } from "./adapter";
import { HttpConfigurationAuditAdapter } from "./http-adapter";
import { SampleConfigurationAuditAdapter } from "./sample-adapter";

export const configurationAudit: ConfigurationAuditAdapter =
  process.env.NODE_ENV === "development"
    ? new SampleConfigurationAuditAdapter()
    : new HttpConfigurationAuditAdapter();

export const listRepositoryConfigurationAudit =
  configurationAudit.listRepositoryConfigurationAudit.bind(configurationAudit);
export const getRepositoryConfigurationAudit =
  configurationAudit.getRepositoryConfigurationAudit.bind(configurationAudit);
export const listGlobalConfigurationAudit =
  configurationAudit.listGlobalConfigurationAudit.bind(configurationAudit);
export const getGlobalConfigurationAudit =
  configurationAudit.getGlobalConfigurationAudit.bind(configurationAudit);

export type {
  ConfigurationAuditAdapter,
  ConfigurationAuditPageQuery,
  GlobalConfigurationAuditQuery,
} from "./adapter";
export { HttpConfigurationAuditAdapter } from "./http-adapter";
export {
  ConfigurationAuditUnavailableError,
  SampleConfigurationAuditAdapter,
} from "./sample-adapter";
export { compareConfigurationAuditSummaries, configurationAuditEventMatches } from "./validation";
