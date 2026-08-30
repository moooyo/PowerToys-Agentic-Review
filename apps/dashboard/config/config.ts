import { defineConfig } from "@umijs/max";
import defaultSettings from "./defaultSettings";
import routes from "./routes";

export default defineConfig({
  antd: {
    configProvider: {
      theme: {
        cssVar: true,
        hashed: true,
        token: {
          colorPrimary: "#1677ff",
          borderRadius: 6,
          fontFamily: "Inter, 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
          fontSize: 14,
          controlHeight: 32,
          controlHeightSM: 26,
          wireframe: false,
        },
        components: {
          Card: {
            borderRadiusLG: 8,
          },
          Table: {
            cellPaddingBlock: 10,
            cellPaddingInline: 12,
            cellPaddingBlockSM: 7,
            cellPaddingInlineSM: 10,
            headerBg: "#f7f8fa",
          },
        },
      },
    },
  },
  access: {},
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
  moment2dayjs: {
    preset: "antd",
    plugins: ["duration", "relativeTime"],
  },
  npmClient: "pnpm",
  routes,
  title: "Agentic Review",
});
