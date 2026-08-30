import type { InitialState } from "./app";

export default function access(initialState: InitialState | undefined) {
  const roles = initialState?.currentUser.roles ?? [];

  return {
    canRead: roles.includes("review-operator"),
    canApprove: process.env.NODE_ENV === "development" && roles.includes("review-operator"),
    canManageWorkers: roles.includes("review-operator"),
    canManageSystem: roles.includes("review-operator"),
    canPublish: process.env.NODE_ENV === "development" && roles.includes("review-operator"),
  };
}
