import type { PaletteMode } from "@mui/material";
import { alpha, CssBaseline, createTheme, ThemeProvider } from "@mui/material";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

const ModeContext = createContext<{ mode: PaletteMode; toggle: () => void }>({
  mode: "light",
  toggle: () => {},
});
export const useColorMode = () => useContext(ModeContext);

// Keep overlays inside the identity boundary and beside the shell for ModalManager.
const overlayContainer = () => document.getElementById("dashboard-session") ?? document.body;

function materialTheme(mode: PaletteMode) {
  const dark = mode === "dark";
  const colors = dark
    ? {
        primary: "#D0BCFF",
        onPrimary: "#381E72",
        primaryContainer: "#4F378B",
        onPrimaryContainer: "#EADDFF",
        secondary: "#CCC2DC",
        secondaryContainer: "#4A4458",
        onSecondaryContainer: "#E8DEF8",
        surface: "#141218",
        canvas: "#1D1B20",
        container: "#211F26",
        containerHigh: "#2B2930",
        onSurface: "#E6E0E9",
        onSurfaceVariant: "#CAC4D0",
        outline: "#938F99",
        outlineVariant: "#49454F",
      }
    : {
        primary: "#6750A4",
        onPrimary: "#FFFFFF",
        primaryContainer: "#EADDFF",
        onPrimaryContainer: "#21005D",
        secondary: "#625B71",
        secondaryContainer: "#E8DEF8",
        onSecondaryContainer: "#1D192B",
        surface: "#FFFBFE",
        canvas: "#F7F2FA",
        container: "#F3EDF7",
        containerHigh: "#ECE6F0",
        onSurface: "#1D1B20",
        onSurfaceVariant: "#49454F",
        outline: "#79747E",
        outlineVariant: "#CAC4D0",
      };
  return createTheme({
    cssVariables: true,
    palette: {
      mode,
      primary: { main: colors.primary, contrastText: colors.onPrimary },
      secondary: { main: colors.secondary },
      background: { default: colors.canvas, paper: colors.surface },
      text: { primary: colors.onSurface, secondary: colors.onSurfaceVariant },
      divider: colors.outlineVariant,
      error: { main: dark ? "#F2B8B5" : "#B3261E" },
      success: { main: dark ? "#9CD49A" : "#386A38" },
      warning: { main: dark ? "#F5BD6F" : "#825500" },
      info: { main: dark ? "#A8C7FA" : "#365E9D" },
      action: {
        hover: alpha(colors.onSurface, 0.08),
        selected: alpha(colors.primary, 0.12),
        focus: alpha(colors.primary, 0.12),
      },
    },
    shape: { borderRadius: 12 },
    typography: {
      fontFamily: '"Roboto", "Segoe UI", sans-serif',
      fontSize: 14,
      fontWeightRegular: 400,
      fontWeightMedium: 500,
      fontWeightBold: 700,
      h1: { fontSize: "2rem", lineHeight: 1.25, fontWeight: 400, letterSpacing: 0 },
      h2: { fontSize: "1.75rem", lineHeight: 1.2857, fontWeight: 400, letterSpacing: 0 },
      h3: { fontSize: "1.5rem", lineHeight: 1.3333, fontWeight: 400, letterSpacing: 0 },
      h4: { fontSize: "1.375rem", lineHeight: 1.2727, fontWeight: 400, letterSpacing: 0 },
      h5: { fontSize: "1.375rem", lineHeight: 1.2727, fontWeight: 400, letterSpacing: 0 },
      h6: { fontSize: "1.375rem", lineHeight: 1.2727, fontWeight: 400, letterSpacing: 0 },
      subtitle1: { fontSize: "1rem", lineHeight: 1.5, fontWeight: 500, letterSpacing: ".15px" },
      subtitle2: {
        fontSize: ".875rem",
        lineHeight: 1.4286,
        fontWeight: 500,
        letterSpacing: ".1px",
      },
      body1: { fontSize: "1rem", lineHeight: 1.5, letterSpacing: ".25px" },
      body2: { fontSize: ".875rem", lineHeight: 1.4286, letterSpacing: ".25px" },
      caption: { fontSize: ".75rem", lineHeight: 1.3333, letterSpacing: ".4px" },
      overline: {
        fontSize: ".875rem",
        lineHeight: 1.4286,
        fontWeight: 500,
        letterSpacing: ".1px",
        textTransform: "none",
      },
      button: {
        fontSize: ".875rem",
        lineHeight: 1.4286,
        fontWeight: 500,
        letterSpacing: ".1px",
        textTransform: "none",
      },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          ":root": {
            "--app-primary-container": colors.primaryContainer,
            "--app-on-primary-container": colors.onPrimaryContainer,
            "--app-secondary-container": colors.secondaryContainer,
            "--app-on-secondary-container": colors.onSecondaryContainer,
            "--app-surface-container": colors.container,
            "--app-surface-container-high": colors.containerHigh,
            "--app-outline": colors.outline,
          },
          body: { margin: 0 },
          ":focus-visible": { outline: "3px solid " + colors.primary, outlineOffset: 3 },
        },
      },
      MuiAppBar: {
        defaultProps: { elevation: 0, color: "default" },
        styleOverrides: {
          root: {
            backgroundColor: colors.canvas,
            color: colors.onSurface,
            backgroundImage: "none",
          },
        },
      },
      MuiButton: {
        defaultProps: { size: "medium", disableElevation: true },
        styleOverrides: {
          root: { borderRadius: 100, minHeight: 40, padding: "10px 24px", fontWeight: 500 },
          sizeSmall: { minHeight: 40, padding: "10px 16px" },
          text: { paddingInline: 16 },
          outlined: { borderColor: colors.outline },
          startIcon: { marginRight: 8 },
        },
      },
      MuiIconButton: {
        defaultProps: { size: "medium" },
        styleOverrides: { root: { width: 40, height: 40, borderRadius: "50%", flexShrink: 0 } },
      },
      MuiAvatar: {
        styleOverrides: {
          root: {
            color: colors.onPrimaryContainer,
            backgroundColor: colors.primaryContainer,
            fontSize: "1rem",
          },
        },
      },
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: { backgroundImage: "none" },
          outlined: { borderColor: colors.outlineVariant },
        },
      },
      MuiCard: { defaultProps: { variant: "outlined" } },
      MuiCardHeader: {
        styleOverrides: { root: { padding: 24 }, action: { margin: 0, alignSelf: "center" } },
      },
      MuiCardContent: {
        styleOverrides: { root: { padding: 24, "&:last-child": { paddingBottom: 24 } } },
      },
      MuiCardActions: { styleOverrides: { root: { padding: "8px 16px 16px", gap: 8 } } },
      MuiTextField: { defaultProps: { size: "medium", variant: "outlined" } },
      MuiFormControl: { defaultProps: { size: "medium" } },
      MuiInputBase: { styleOverrides: { root: { fontSize: "1rem", lineHeight: 1.5 } } },
      MuiOutlinedInput: {
        styleOverrides: {
          root: { borderRadius: 4 },
          notchedOutline: { borderColor: colors.outline },
        },
      },
      MuiFilledInput: {
        styleOverrides: {
          root: { borderRadius: "4px 4px 0 0", backgroundColor: colors.containerHigh },
        },
      },
      MuiChip: {
        defaultProps: { size: "medium" },
        styleOverrides: {
          root: {
            borderRadius: 8,
            height: 32,
            fontSize: ".875rem",
            lineHeight: 1.4286,
            fontWeight: 500,
          },
          sizeSmall: { height: 32, fontSize: ".875rem" },
          outlined: { borderColor: colors.outline },
          label: { paddingInline: 12 },
        },
      },
      MuiTableCell: {
        styleOverrides: {
          root: {
            padding: "16px",
            fontSize: ".875rem",
            lineHeight: 1.4286,
            verticalAlign: "top",
            borderBottomColor: colors.outlineVariant,
          },
          sizeSmall: { padding: "12px 16px" },
          head: {
            color: colors.onSurfaceVariant,
            fontWeight: 500,
            fontSize: ".875rem",
            backgroundColor: colors.canvas,
            whiteSpace: "nowrap",
          },
        },
      },
      MuiTablePagination: {
        styleOverrides: {
          toolbar: { minHeight: 64 },
          selectLabel: { fontSize: ".875rem" },
          displayedRows: { fontSize: ".875rem" },
        },
      },
      MuiTab: {
        styleOverrides: {
          root: {
            minHeight: 48,
            textTransform: "none",
            fontSize: ".875rem",
            fontWeight: 500,
            letterSpacing: ".1px",
          },
        },
      },
      MuiTabs: {
        styleOverrides: {
          root: { minHeight: 48 },
          indicator: { height: 3, borderRadius: "3px 3px 0 0" },
        },
      },
      MuiListItemButton: { styleOverrides: { root: { minHeight: 48 } } },
      MuiDialog: {
        defaultProps: { fullWidth: true, container: overlayContainer },
        styleOverrides: { paper: { borderRadius: 28, backgroundColor: colors.canvas } },
      },
      MuiDialogTitle: {
        styleOverrides: {
          root: {
            fontSize: "1.5rem",
            lineHeight: 1.3333,
            fontWeight: 400,
            padding: "24px 24px 16px",
          },
        },
      },
      MuiDialogContent: { styleOverrides: { root: { padding: "8px 24px 24px" } } },
      MuiDialogActions: { styleOverrides: { root: { padding: "8px 24px 24px", gap: 8 } } },
      MuiDrawer: { defaultProps: { ModalProps: { container: overlayContainer } } },
      MuiModal: { defaultProps: { container: overlayContainer } },
      MuiPopover: { defaultProps: { container: overlayContainer } },
      MuiPopper: { defaultProps: { container: overlayContainer } },
      MuiMenu: {
        styleOverrides: { paper: { backgroundColor: colors.container, borderRadius: 12 } },
      },
      MuiAlert: {
        styleOverrides: {
          root: {
            borderRadius: 12,
            alignItems: "flex-start",
            fontSize: ".875rem",
            lineHeight: 1.4286,
          },
          message: { paddingBlock: 4 },
        },
      },
      MuiAlertTitle: { styleOverrides: { root: { fontSize: "1rem", fontWeight: 500 } } },
      MuiAccordion: {
        defaultProps: { disableGutters: true, elevation: 0 },
        styleOverrides: {
          root: {
            backgroundColor: colors.canvas,
            "&:before": { display: "none" },
            "&:first-of-type": { borderTopLeftRadius: 12, borderTopRightRadius: 12 },
            "&:last-of-type": { borderBottomLeftRadius: 12, borderBottomRightRadius: 12 },
          },
        },
      },
      MuiAccordionSummary: { styleOverrides: { root: { minHeight: 56, paddingInline: 20 } } },
      MuiAccordionDetails: { styleOverrides: { root: { padding: "0 20px 20px" } } },
    },
  });
}

export function MaterialTheme({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<PaletteMode>("light");
  const value = useMemo(
    () => ({
      mode,
      toggle: () => setMode((previous) => (previous === "light" ? "dark" : "light")),
    }),
    [mode],
  );
  const theme = useMemo(() => materialTheme(mode), [mode]);
  return (
    <ModeContext.Provider value={value}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </ModeContext.Provider>
  );
}
