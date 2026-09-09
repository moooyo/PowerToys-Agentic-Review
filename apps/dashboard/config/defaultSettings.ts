import type { ProLayoutProps } from "@ant-design/pro-components";

const defaultSettings: ProLayoutProps = {
  title: "Agentic Review",
  layout: "side",
  navTheme: "light",
  contentWidth: "Fluid",
  fixedHeader: true,
  fixSiderbar: true,
  siderWidth: 208,
  splitMenus: false,
  colorPrimary: "#1677ff",
  token: {
    bgLayout: "#f5f5f5",
    sider: {
      colorMenuBackground: "#ffffff",
      colorTextMenuSelected: "#1677ff",
      colorBgMenuItemSelected: "#e6f4ff",
      colorBgMenuItemActive: "#e6f4ff",
    },
    header: {
      colorBgHeader: "#ffffff",
      colorBgScrollHeader: "#ffffff",
      heightLayoutHeader: 56,
    },
    pageContainer: {
      colorBgPageContainer: "#ffffff",
      paddingInlinePageContainerContent: 24,
      paddingBlockPageContainerContent: 24,
    },
  },
};

export default defaultSettings;
