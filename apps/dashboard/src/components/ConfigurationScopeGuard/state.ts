export interface ConfigurationScopeState {
  readonly scopeKey: string;
  readonly wasVerified: boolean;
}

export function nextConfigurationScopeState(
  previous: ConfigurationScopeState,
  scopeKey: string,
  available: boolean,
): ConfigurationScopeState {
  if (previous.scopeKey !== scopeKey) return { scopeKey, wasVerified: available };
  if (available && !previous.wasVerified) return { scopeKey, wasVerified: true };
  return previous;
}
