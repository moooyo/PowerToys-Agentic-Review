export default [
  {
    path: "/",
    redirect: "/work-items",
  },
  {
    path: "/work-items",
    name: "Work Items",
    icon: "inbox",
    access: "canRead",
    component: "./WorkItems",
  },
  {
    path: "/jobs",
    name: "Jobs",
    icon: "deploymentUnit",
    access: "canRead",
    component: "./Jobs",
  },
  {
    path: "/workers",
    name: "Workers",
    icon: "cluster",
    access: "canManageWorkers",
    component: "./Workers",
  },
  {
    path: "/approvals",
    name: "Approvals",
    icon: "audit",
    access: "canApprove",
    component: "./Approvals",
  },
  {
    path: "/publications",
    name: "Publications",
    icon: "send",
    access: "canPublish",
    component: "./Publications",
  },
  {
    path: "/system",
    name: "System",
    icon: "control",
    access: "canManageSystem",
    component: "./System",
  },
  {
    path: "/signed-out",
    layout: false,
    component: "./SignedOut",
  },
  {
    path: "/*",
    layout: false,
    component: "./NotFound",
  },
];
