import type { PaletteMode } from "@mui/material";
import { alpha, CssBaseline, createTheme, ThemeProvider } from "@mui/material";
import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

const ModeContext = createContext<{ mode: PaletteMode; toggle: () => void }>({
  mode: "light",
  toggle: () => {},
});
export const useColorMode = () => useContext(ModeContext);

// Keep overlays inside the identity boundary and beside the shell for ModalManager.
const overlayContainer = () => document.getElementById("dashboard-session") ?? document.body;

function materialTheme(mode: PaletteMode) {
  const dark = mode === "dark";
  const tokens = dark
    ? {
        background: "#111318",
        surface: "#1D2026",
        elevated: "#2A2D34",
        "surface-high": "#2C2F36",
        chip: "#2E3138",
        "chip-subtle": "#2E3138",
        tool: "#262930",
        "tool-hover": "#30333A",
        subtle: "#23262C",
        session: "#191C21",
        "worker-icon": "#262930",
        text: "#E2E2E9",
        body: "#D0D3DC",
        "body-strong": "#D6D9E2",
        secondary: "#C4C6D0",
        outline: "#8E9099",
        faint: "#7D828C",
        "outline-variant": "#44474F",
        border: "#3A3D44",
        divider: "#33363D",
        "divider-subtle": "#2A2D33",
        primary: "#AFC6FF",
        "primary-hover": "#C6D5FF",
        "on-primary": "#1D2026",
        selected: "#3E4759",
        "on-selected": "#DAE2F9",
        "tonal-hover": "#4A5468",
        "primary-container": "#234786",
        "on-primary-container": "#D8E2FF",
        "primary-tint": "#1E2A42",
        "selected-card": "#1E2433",
        ring: "#3A5490",
        inverse: "#E2E2E9",
        "on-inverse": "#2F3036",
        "inverse-primary": "#345EAD",
        error: "#FFB4AB",
        "on-error": "#1D2026",
        "error-container": "#4A1E1B",
        "on-error-container": "#FFDAD6",
        "error-icon": "#6B2722",
        warning: "#FFB95C",
        "warning-container": "#4A3510",
        "on-warning-container": "#FFDDB3",
        "warning-strong": "#5C4212",
        "warning-text": "#FFDDB3",
        "warning-code": "#3D2F12",
        "issue-icon": "#4F3A12",
        "stale-dot": "#FFB95C",
        success: "#8BD5B5",
        "success-container": "#1F3B2F",
        "on-success-container": "#A6F2D0",
        "success-banner": "#1A3329",
        "success-banner-soft": "#1A3329",
        "success-text": "#BDEFD6",
        "success-dot": "#6DD3A5",
        "alternate-avatar": "#4A2F52",
        "on-alternate-avatar": "#F5D9FF",
      }
    : {
        background: "#F1F4FA",
        surface: "#FFFFFF",
        elevated: "#FFFFFF",
        "surface-high": "#E3E8F2",
        chip: "#E7EBF4",
        "chip-subtle": "#EDF0F7",
        tool: "#EEF1F7",
        "tool-hover": "#E6EAF3",
        subtle: "#F6F8FC",
        session: "#FBFCFE",
        "worker-icon": "#EEF1F8",
        text: "#1B1D24",
        body: "#434A57",
        "body-strong": "#3A4250",
        secondary: "#505966",
        outline: "#737D8C",
        faint: "#9AA3B2",
        "outline-variant": "#C4CAD6",
        border: "#D4DAE5",
        divider: "#E1E5EE",
        "divider-subtle": "#EEF1F6",
        primary: "#345EAD",
        "primary-hover": "#2C54A0",
        "on-primary": "#FFFFFF",
        selected: "#DAE2F9",
        "on-selected": "#131C2B",
        "tonal-hover": "#CCD6F2",
        "primary-container": "#DCE6FF",
        "on-primary-container": "#173D79",
        "primary-tint": "#EEF3FF",
        "selected-card": "#F6F8FF",
        ring: "#C9D8FF",
        inverse: "#2F3036",
        "on-inverse": "#F1F0F7",
        "inverse-primary": "#AFC6FF",
        error: "#B3261E",
        "on-error": "#FFFFFF",
        "error-container": "#FCEAE9",
        "on-error-container": "#8C1D18",
        "error-icon": "#F9D3D0",
        warning: "#8B5000",
        "warning-container": "#FFF0D4",
        "on-warning-container": "#6A3D00",
        "warning-strong": "#FFE3B0",
        "warning-text": "#775000",
        "warning-code": "#FFF4DE",
        "issue-icon": "#FFE9C2",
        "stale-dot": "#D08A12",
        success: "#25634E",
        "success-container": "#E1F0E6",
        "on-success-container": "#1D5A45",
        "success-banner": "#EAF5EE",
        "success-banner-soft": "#EEF7F1",
        "success-text": "#1D4A3A",
        "success-dot": "#2F9E6E",
        "alternate-avatar": "#F3DDF5",
        "on-alternate-avatar": "#5B2C6F",
      };
  const colors = {
    primary: tokens.primary,
    onPrimary: tokens["on-primary"],
    primaryContainer: tokens["primary-container"],
    onPrimaryContainer: tokens["on-primary-container"],
    secondary: tokens.secondary,
    secondaryContainer: tokens.selected,
    onSecondaryContainer: tokens["on-selected"],
    surface: tokens.surface,
    canvas: tokens.background,
    surfaceLow: tokens.subtle,
    container: tokens.chip,
    containerHigh: tokens["surface-high"],
    onSurface: tokens.text,
    onSurfaceVariant: tokens.secondary,
    outline: tokens.outline,
    outlineVariant: tokens["outline-variant"],
  };
  const semanticColors = {
    error: tokens.error,
    success: tokens.success,
    warning: tokens.warning,
    info: tokens.primary,
  };
  const semanticContainers = {
    error: tokens["error-container"],
    success: tokens["success-container"],
    warning: tokens["warning-container"],
    info: tokens["primary-tint"],
  };
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
      divider: tokens.divider,
      error: { main: semanticColors.error, contrastText: tokens["on-error"] },
      success: { main: semanticColors.success },
      warning: { main: semanticColors.warning },
      info: { main: semanticColors.info },
      action: {
        hover: alpha(colors.onSurface, 0.08),
        selected: alpha(colors.primary, 0.12),
        focus: alpha(colors.primary, 0.12),
      },
    },
    // Keep the sx radius unit at 4px; M3 surface and dialog roles are explicit below.
    shape: { borderRadius: 4 },
    typography: {
      fontFamily: '"Roboto Flex", "Noto Sans SC", system-ui, sans-serif',
      fontSize: 14,
      fontWeightRegular: 400,
      fontWeightMedium: 500,
      fontWeightBold: 700,
      h1: {
        fontSize: "1.75rem",
        lineHeight: "2.25rem",
        fontWeight: 400,
        letterSpacing: 0,
      },
      h2: { fontSize: "1.375rem", lineHeight: "1.75rem", fontWeight: 400, letterSpacing: 0 },
      h3: { fontSize: "1rem", lineHeight: 1.5, fontWeight: 500, letterSpacing: 0 },
      h4: { fontSize: "1.375rem", lineHeight: 1.2727, fontWeight: 400, letterSpacing: 0 },
      h5: { fontSize: "1.375rem", lineHeight: 1.2727, fontWeight: 400, letterSpacing: 0 },
      h6: { fontSize: "1.375rem", lineHeight: 1.2727, fontWeight: 400, letterSpacing: 0 },
      subtitle1: { fontSize: "1rem", lineHeight: 1.5, fontWeight: 500, letterSpacing: 0 },
      subtitle2: {
        fontSize: ".875rem",
        lineHeight: 1.4286,
        fontWeight: 500,
        letterSpacing: 0,
      },
      body1: { fontSize: "1rem", lineHeight: 1.5, letterSpacing: 0 },
      body2: { fontSize: ".875rem", lineHeight: 1.4286, letterSpacing: 0 },
      caption: { fontSize: ".75rem", lineHeight: 1.3333, letterSpacing: 0 },
      overline: {
        fontSize: ".875rem",
        lineHeight: 1.4286,
        fontWeight: 500,
        letterSpacing: 0,
        textTransform: "none",
      },
      button: {
        fontSize: ".875rem",
        lineHeight: 1.4286,
        fontWeight: 500,
        letterSpacing: 0,
        textTransform: "none",
      },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          ":root": {
            ...Object.fromEntries(
              Object.entries(tokens).map(([name, value]) => [`--console-${name}`, value]),
            ),
            "--console-overlay": dark ? "226,226,233" : "27,29,36",
            "--console-overlay-primary": dark ? "175,198,255" : "52,94,173",
            "--console-overlay-success": dark ? "139,213,181" : "37,99,78",
            "--console-overlay-error": dark ? "255,180,171" : "179,38,30",
            colorScheme: mode,
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
          body: { margin: 0, WebkitFontSmoothing: "antialiased" },
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
            padding: "9px 20px",
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
            "&:hover": { backgroundColor: alpha(colors.onSurface, 0.08) },
            "&:active": { backgroundColor: alpha(colors.onSurface, 0.12) },
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
      MuiFormControlLabel: {
        styleOverrides: {
          root: { minHeight: 48, marginRight: 12 },
          label: { overflowWrap: "anywhere" },
        },
      },
      MuiCheckbox: {
        styleOverrides: {
          root: {
            width: 48,
            height: 48,
            padding: 12,
            flexShrink: 0,
            color: colors.onSurfaceVariant,
          },
        },
      },
      MuiRadio: {
        styleOverrides: {
          root: {
            width: 48,
            height: 48,
            padding: 12,
            flexShrink: 0,
            color: colors.onSurfaceVariant,
          },
        },
      },
      MuiSwitch: {
        styleOverrides: {
          root: {
            width: 64,
            height: 48,
            padding: "8px 6px",
            overflow: "visible",
            flexShrink: 0,
          },
          switchBase: ({ ownerState }) => {
            const color = ownerState.color ?? "primary";
            const activeColor =
              color === "default" ? colors.primary : `var(--mui-palette-${color}-main)`;
            const onActiveColor =
              color === "default" ? colors.onPrimary : `var(--mui-palette-${color}-contrastText)`;
            return {
              top: 2,
              padding: 14,
              color: colors.outline,
              "&.Mui-checked": {
                transform: "translateX(20px)",
                padding: 10,
                color: onActiveColor,
                "& .MuiSwitch-thumb": { width: 24, height: 24 },
                "& + .MuiSwitch-track": {
                  opacity: 1,
                  backgroundColor: activeColor,
                  borderColor: activeColor,
                },
              },
              "&.Mui-disabled": { color: alpha(colors.onSurface, 0.38) },
              "&.Mui-disabled + .MuiSwitch-track": {
                opacity: 0.12,
                backgroundColor: colors.onSurface,
                borderColor: colors.onSurface,
              },
            };
          },
          thumb: { width: 16, height: 16, boxShadow: "none" },
          track: {
            boxSizing: "border-box",
            borderRadius: 16,
            border: `2px solid ${colors.outline}`,
            backgroundColor: colors.containerHigh,
            opacity: 1,
          },
        },
      },
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
            backgroundColor: tokens.elevated,
            backgroundImage: "none",
            minWidth: 0,
            "@media (max-width: 599px)": {
              margin: 12,
              width: "calc(100% - 24px)",
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
            minHeight: 0,
            overscrollBehavior: "contain",
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
            flexShrink: 0,
            "@media (max-width: 599px)": { paddingInline: 20 },
          },
        },
      },
      MuiDrawer: { defaultProps: { ModalProps: { container: overlayContainer } } },
      MuiModal: { defaultProps: { container: overlayContainer } },
      MuiPopover: { defaultProps: { container: overlayContainer } },
      MuiPopper: { defaultProps: { container: overlayContainer } },
      MuiMenu: {
        styleOverrides: { paper: { backgroundColor: tokens.elevated, borderRadius: 16 } },
      },
      MuiSnackbarContent: {
        styleOverrides: {
          root: {
            color: tokens["on-inverse"],
            backgroundColor: tokens.inverse,
            borderRadius: 4,
            boxShadow: "0 3px 8px rgb(0 0 0 / 20%)",
          },
          action: {
            color: tokens["inverse-primary"],
            "& .MuiButton-root, & .MuiIconButton-root": { color: "inherit" },
          },
        },
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
  const [mode, setMode] = useState<PaletteMode>(() => {
    try {
      return typeof window !== "undefined" &&
        window.localStorage.getItem("agentic-review-theme") === "dark"
        ? "dark"
        : "light";
    } catch {
      return "light";
    }
  });
  useLayoutEffect(() => {
    document.documentElement.style.colorScheme = mode;
    document.documentElement.style.backgroundColor = mode === "dark" ? "#111318" : "#F1F4FA";
    document.documentElement.dataset.consoleTheme = mode;
    document
      .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.setAttribute("content", mode === "dark" ? "#111318" : "#F1F4FA");
    try {
      window.localStorage.setItem("agentic-review-theme", mode);
    } catch {
      // Theme switching remains available when browser storage is unavailable.
    }
  }, [mode]);
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
