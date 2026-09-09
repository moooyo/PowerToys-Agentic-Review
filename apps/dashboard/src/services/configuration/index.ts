import type { ConfigurationAdapter } from "./adapter";
import { HttpConfigurationAdapter } from "./http-adapter";
import { MockConfigurationAdapter } from "./mock-adapter";

export const configuration: ConfigurationAdapter =
  process.env.NODE_ENV === "development"
    ? new MockConfigurationAdapter()
    : new HttpConfigurationAdapter();

export type * from "./adapter";
export { HttpConfigurationAdapter } from "./http-adapter";
export { MockConfigurationAdapter, type MockConfigurationAdapterOptions } from "./mock-adapter";
