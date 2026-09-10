import type { InitialState } from "@/state/session";

export function operatorSessionKey(
  state: InitialState | undefined,
  mode: "sample" | "connected",
): string {
  return JSON.stringify([
    mode,
    state?.sessionEpoch ?? 0,
    state?.authenticated === true,
    state?.authenticated ? (state.currentUser.principal?.issuer ?? null) : null,
    state?.authenticated ? (state.currentUser.principal?.subject ?? null) : null,
  ]);
}
