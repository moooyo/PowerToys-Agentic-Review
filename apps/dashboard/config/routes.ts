export default [
  { path: "/", hideInMenu: true, redirect: "/inbox" },
  { path: "/inbox", name: "Inbox", component: "./ReviewConsole" },
  { path: "/settings", name: "Settings", component: "./ConsoleSettings" },
];
