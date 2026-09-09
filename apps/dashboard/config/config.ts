import { defineConfig } from "@umijs/max";
import defaultSettings from "./defaultSettings";
import routes from "./routes";

export default defineConfig({
  antd: {
    configProvider: {
      theme: {
        cssVar: true,
        hashed: true,
      },
    },
  },
  access: {},
  chainWebpack(webpackConfig) {
    // CPU count does not represent the memory available to a build container.
    // Minify in the existing process instead of spawning a process for each CPU.
    if (webpackConfig.optimization.get("minimize") === true) {
      for (const name of ["js-esbuild", "css-esbuild"]) {
        webpackConfig.optimization
          .minimizer(name)
          .tap(([options]) => [{ ...options, parallel: false }]);
      }
    }
  },
  esbuildMinifyIIFE: true,
  fastRefresh: true,
  hash: true,
  history: {
    type: "browser",
  },
  initialState: {},
  layout: {
    locale: false,
    ...defaultSettings,
  },
  locale: {
    default: "en-US",
    antd: true,
    baseNavigator: false,
  },
  model: {},
  // Workspace contracts change without a package version bump; bundle them as application code.
  mfsu: {
    exclude: ["@agentic-review/contracts"],
  },
  moment2dayjs: {
    preset: "antd",
    plugins: ["duration", "relativeTime"],
  },
  npmClient: "pnpm",
  routes,
  title: "Agentic Review",
});
