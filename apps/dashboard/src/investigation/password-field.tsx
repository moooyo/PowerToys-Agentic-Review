import { INVESTIGATION_PASSWORD_MAX_LENGTH } from "@agentic-review/contracts";
import { VisibilityOffOutlined, VisibilityOutlined } from "@mui/icons-material";
import { IconButton, InputAdornment, TextField, type TextFieldProps } from "@mui/material";
import { useEffect, useState } from "react";

export function PasswordField({
  label,
  disabled,
  value,
  ...props
}: Omit<TextFieldProps, "type" | "slotProps"> & { label: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!value) setVisible(false);
  }, [value]);
  return (
    <TextField
      {...props}
      value={value}
      label={label}
      type={visible ? "text" : "password"}
      disabled={disabled}
      fullWidth
      slotProps={{
        htmlInput: { maxLength: INVESTIGATION_PASSWORD_MAX_LENGTH * 2 },
        input: {
          endAdornment: (
            <InputAdornment position="end">
              <IconButton
                type="button"
                edge="end"
                aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
                aria-pressed={visible}
                disabled={disabled}
                onClick={() => setVisible((current) => !current)}
                sx={{
                  minWidth: 44,
                  minHeight: 44,
                  "@media (pointer: coarse)": { minWidth: 48, minHeight: 48 },
                }}
              >
                {visible ? <VisibilityOffOutlined /> : <VisibilityOutlined />}
              </IconButton>
            </InputAdornment>
          ),
        },
      }}
    />
  );
}

export function focusInvalidAccountField(formId: string) {
  window.requestAnimationFrame(() => {
    const field = document
      .getElementById(formId)
      ?.querySelector<HTMLElement>('[aria-invalid="true"]');
    field?.focus();
    field?.scrollIntoView({ block: "nearest", behavior: "auto" });
  });
}
