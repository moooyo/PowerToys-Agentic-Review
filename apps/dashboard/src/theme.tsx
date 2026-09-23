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
        primary: "#B2C7FF",
        onPrimary: "#002E6D",
        primaryContainer: "#24467E",
        onPrimaryContainer: "#DBE5FF",
        secondary: "#BAC2D0",
        secondaryContainer: "#303A50",
        onSecondaryContainer: "#DBE5FF",
        surface: "#181C24",
        canvas: "#10141B",
        surfaceLow: "#181C24",
        container: "#20252F",
        containerHigh: "#2B313D",
        onSurface: "#E3E5ED",
        onSurfaceVariant: "#BAC2D0",
        outline: "#8994A5",
        outlineVariant: "#414A58",
      }
    : {
        primary: "#345EAD",
        onPrimary: "#FFFFFF",
        primaryContainer: "#DCE6FF",
        onPrimaryContainer: "#173D79",
        secondary: "#505966",
        secondaryContainer: "#DFE6F4",
        onSecondaryContainer: "#25344E",
        surface: "#FFFFFF",
        canvas: "#FAF9FD",
        surfaceLow: "#F3F4FA",
        container: "#EDF0F7",
        containerHigh: "#E7EBF4",
        onSurface: "#1B1D24",
        onSurfaceVariant: "#505966",
        outline: "#737D8C",
        outlineVariant: "#D4DAE5",
      };
  const semanticColors = {
    error: dark ? "#F2B8B5" : "#B3261E",
    success: dark ? "#91D4B4" : "#25634E",
    warning: dark ? "#F1C779" : "#775000",
    info: dark ? "#A8C7FA" : "#365E9D",
  };
  const semanticContainers = dark
    ? { error: "#4A2527", success: "#1D372E", warning: "#3C3020", info: "#20364F" }
    : { error: "#FCEAE9", success: "#E6F1EA", warning: "#FFF0D4", info: "#E4ECF9" };
  const chipTones = {
    primary: { color: colors.onPrimaryContainer, backgroundColor: colors.primaryContainer },
    secondary: { color: colors.onSecondaryContainer, backgroundColor: colors.secondaryContainer },
    ...Object.fromEntries(
      Object.entries(semanticColors).map(([name, color]) => [
        name,
        {
          color,
          backgroundColor: semanticContainers[name as keyof typeof semanticContainers],
        },
      ]),
    ),
  } as Record<string, { color: string; backgroundColor: string }>;
  return createTheme({
    cssVariables: true,
    palette: {
      mode,
      primary: { main: colors.primary, contrastText: colors.onPrimary },
      secondary: { main: colors.secondary },
      background: { default: colors.canvas, paper: colors.surface },
      text: { primary: colors.onSurface, secondary: colors.onSurfaceVariant },
      divider: colors.outlineVariant,
      error: { main: semanticColors.error },
      success: { main: semanticColors.success },
      warning: { main: semanticColors.warning },
      info: { main: semanticColors.info },
      action: {
        hover: alpha(colors.primary, 0.08),
        selected: alpha(colors.primary, 0.12),
        focus: alpha(colors.primary, 0.12),
      },
    },
    // Keep the sx radius unit at 4px; M3 surface and dialog roles are explicit below.
    shape: { borderRadius: 4 },
    typography: {
      fontFamily: '"Roboto", "Segoe UI", sans-serif',
      fontSize: 14,
      fontWeightRegular: 400,
      fontWeightMedium: 500,
      fontWeightBold: 700,
      h1: {
        fontSize: "1.75rem",
        lineHeight: "2.25rem",
        fontWeight: 400,
        letterSpacing: "-.35px",
      },
      h2: { fontSize: "1.375rem", lineHeight: "1.75rem", fontWeight: 400, letterSpacing: 0 },
      h3: { fontSize: "1rem", lineHeight: 1.5, fontWeight: 500, letterSpacing: 0 },
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
            "--app-surface-low": colors.surfaceLow,
            "--app-surface-container": colors.container,
            "--app-surface-container-high": colors.containerHigh,
            "--app-outline": colors.outline,
            "--app-pressed": alpha(colors.primary, 0.12),
            "--app-shape-surface": "16px",
            "--app-shape-dialog": "28px",
          },
          body: { margin: 0 },
          ":focus-visible": { outline: `3px solid ${colors.primary}`, outlineOffset: 3 },
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
      MuiButtonBase: {
        styleOverrides: {
          root: {
            touchAction: "manipulation",
            "&.Mui-focusVisible": {
              outline: `3px solid ${colors.primary}`,
              outlineOffset: 3,
            },
          },
        },
      },
      MuiButton: {
        defaultProps: { size: "medium", disableElevation: true },
        styleOverrides: {
          root: {
            borderRadius: 100,
            minHeight: 40,
            maxWidth: "100%",
            padding: "9px 24px",
            fontWeight: 500,
            whiteSpace: "normal",
            overflowWrap: "anywhere",
            transition: "background-color 160ms ease, box-shadow 160ms ease",
          },
          sizeSmall: { minHeight: 40, padding: "9px 12px" },
          text: {
            paddingInline: 12,
            "&:hover": { backgroundColor: "color-mix(in srgb, currentColor 8%, transparent)" },
            "&:active": { backgroundColor: "color-mix(in srgb, currentColor 12%, transparent)" },
          },
          outlined: {
            borderColor: colors.outline,
            "&:hover": { backgroundColor: "color-mix(in srgb, currentColor 8%, transparent)" },
            "&:active": { backgroundColor: "color-mix(in srgb, currentColor 12%, transparent)" },
          },
          contained: ({ ownerState }) => {
            const color = ownerState.color ?? "primary";
            if (color === "inherit") return { boxShadow: "none" };
            const background = `var(--mui-palette-${color}-main)`;
            const foreground = `var(--mui-palette-${color}-contrastText)`;
            return {
              boxShadow: "none",
              "&:hover": {
                backgroundColor: `color-mix(in srgb, ${background} 92%, ${foreground})`,
                boxShadow: "0 1px 3px rgb(0 0 0 / 16%)",
              },
              "&:active": {
                backgroundColor: `color-mix(in srgb, ${background} 88%, ${foreground})`,
                boxShadow: "none",
              },
            };
          },
          startIcon: { marginRight: 8 },
        },
      },
      MuiIconButton: {
        defaultProps: { size: "medium" },
        styleOverrides: {
          root: {
            width: 40,
            height: 40,
            borderRadius: "50%",
            flexShrink: 0,
            transition: "background-color 160ms ease",
            "&:hover": { backgroundColor: alpha(colors.primary, 0.08) },
            "&:active": { backgroundColor: alpha(colors.primary, 0.12) },
          },
        },
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
          root: { backgroundImage: "none", borderRadius: 16 },
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
          root: ({ ownerState }) => ({
            borderRadius: ownerState.clickable || ownerState.onClick ? 8 : 4,
            height: "auto",
            minHeight: ownerState.clickable || ownerState.onClick ? 36 : 24,
            fontSize: ownerState.clickable || ownerState.onClick ? ".875rem" : ".75rem",
            lineHeight: ownerState.clickable || ownerState.onClick ? 1.4286 : 1.3333,
            fontWeight: 500,
            maxWidth: "100%",
            ...(ownerState.variant !== "outlined" && ownerState.color && chipTones[ownerState.color]
              ? {
                  ...chipTones[ownerState.color],
                  "&.MuiChip-clickable:hover": {
                    ...chipTones[ownerState.color],
                    boxShadow: `inset 0 0 0 999px ${alpha(colors.primary, 0.08)}`,
                  },
                  "&.Mui-focusVisible": {
                    ...chipTones[ownerState.color],
                    boxShadow: `inset 0 0 0 999px ${alpha(colors.primary, 0.12)}`,
                  },
                  "&.MuiChip-clickable:active": {
                    ...chipTones[ownerState.color],
                    boxShadow: `inset 0 0 0 999px ${alpha(colors.primary, 0.12)}`,
                  },
                }
              : {}),
          }),
          outlined: { borderColor: colors.outline },
          label: {
            padding: "4px 8px",
            whiteSpace: "normal",
            overflowWrap: "anywhere",
          },
        },
      },
      MuiToggleButton: {
        styleOverrides: {
          root: {
            borderRadius: 8,
            minHeight: 40,
            padding: "9px 12px",
            fontSize: ".875rem",
            lineHeight: 1.4286,
            textTransform: "none",
            "&.Mui-selected": {
              color: colors.onSecondaryContainer,
              backgroundColor: colors.secondaryContainer,
              "&:hover": {
                backgroundColor: colors.secondaryContainer,
                boxShadow: `inset 0 0 0 999px ${alpha(colors.primary, 0.08)}`,
              },
            },
            "&:active": { backgroundColor: alpha(colors.primary, 0.12) },
          },
        },
      },
      MuiTableCell: {
        styleOverrides: {
          root: {
            padding: "14px 12px",
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
            backgroundColor: colors.surfaceLow,
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
            borderRadius: "8px 8px 0 0",
            "&:hover": { backgroundColor: alpha(colors.primary, 0.08) },
            "&:active": { backgroundColor: alpha(colors.primary, 0.12) },
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
        styleOverrides: {
          paper: {
            borderRadius: 28,
            backgroundColor: colors.containerHigh,
            backgroundImage: "none",
            minWidth: 0,
            "@media (max-width: 599px)": {
              margin: 12,
              maxWidth: "calc(100% - 24px)",
              maxHeight: "calc(100% - 24px)",
            },
          },
        },
      },
      MuiDialogTitle: {
        styleOverrides: {
          root: {
            fontSize: "1.5rem",
            lineHeight: 1.3333,
            fontWeight: 400,
            padding: "24px 24px 16px",
            overflowWrap: "anywhere",
            "@media (max-width: 599px)": { paddingInline: 20 },
          },
        },
      },
      MuiDialogContent: {
        styleOverrides: {
          root: {
            padding: "8px 24px 24px",
            minWidth: 0,
            overflowWrap: "anywhere",
            "@media (max-width: 599px)": { paddingInline: 20 },
          },
        },
      },
      MuiDialogActions: {
        styleOverrides: {
          root: {
            padding: "8px 24px 24px",
            gap: 8,
            flexWrap: "wrap",
            "@media (max-width: 599px)": { paddingInline: 20 },
          },
        },
      },
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
          standard: ({ ownerState }) => {
            const severity = ownerState.color ?? ownerState.severity ?? "success";
            return {
              color: semanticColors[severity],
              backgroundColor: semanticContainers[severity],
            };
          },
          icon: { color: "inherit", opacity: 1 },
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
