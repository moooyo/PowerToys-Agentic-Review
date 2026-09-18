export default [
  { path: "/", hideInMenu: true, component: "./WorkspaceRedirect" },
  { path: "/work-items", hideInMenu: true, component: "./WorkspaceRedirect" },
  { path: "/pull-requests", name: "Pull requests", component: "./PullRequests" },
  { path: "/issues", name: "Issues", component: "./Issues" },
  { path: "/tasks", name: "Tasks", component: "./InvestigationTasks" },
  { path: "/comments", name: "Comments", component: "./InvestigationComments" },
  { path: "/reports", name: "Report", hideInMenu: true, component: "./InvestigationReport" },
  { path: "/repositories", name: "Repositories", component: "./InvestigationRepositories" },
  { path: "/account", name: "My account", component: "./MyAccount" },
  { path: "/accounts", name: "Accounts", component: "./Accounts", adminOnly: true },
  { path: "/*", hideInMenu: true, component: "./NotFound" },
];
