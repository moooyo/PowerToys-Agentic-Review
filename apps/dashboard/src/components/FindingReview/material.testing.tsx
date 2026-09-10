import type { ChangeEvent, Key, ReactNode } from "react";

type ContentProps = { children?: ReactNode };
const Content = ({ children }: ContentProps) => <div>{children}</div>;
const Layout = ({ children }: ContentProps) => <>{children}</>;

export const materialComponents = {
  Accordion: Content,
  AccordionDetails: Content,
  AccordionSummary: Content,
  Alert: ({
    children,
    action,
    severity,
  }: ContentProps & { action?: ReactNode; severity?: string }) => (
    <aside data-severity={severity}>
      {children}
      {action}
    </aside>
  ),
  AlertTitle: Content,
  Box: Content,
  Button: ({
    children,
    disabled,
    onClick,
  }: ContentProps & { disabled?: boolean; onClick?: () => void }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  Card: Content,
  CardContent: Content,
  Chip: ({ label, color }: { label?: ReactNode; color?: string }) => (
    <span data-color={color}>{label}</span>
  ),
  IconButton: ({ children, "aria-label": label }: ContentProps & { "aria-label"?: string }) => (
    <button type="button" aria-label={label}>
      {children}
    </button>
  ),
  MenuItem: ({
    children,
    value,
    disabled,
  }: ContentProps & { value?: string; disabled?: boolean }) => (
    <option value={value} disabled={disabled}>
      {children}
    </option>
  ),
  Pagination: Content,
  Skeleton: Content,
  Stack: Layout,
  TextField: ({
    label,
    value,
    disabled,
    multiline,
    children,
    onChange,
  }: ContentProps & {
    label?: string;
    value?: string;
    disabled?: boolean;
    multiline?: boolean;
    onChange?: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  }) => (
    <label htmlFor={label?.replaceAll(" ", "-")}>
      {label}
      {children ??
        (multiline ? (
          <textarea
            id={label?.replaceAll(" ", "-")}
            aria-label={label}
            value={value}
            disabled={disabled}
            onChange={onChange}
          />
        ) : (
          <input
            id={label?.replaceAll(" ", "-")}
            aria-label={label}
            value={value}
            disabled={disabled}
            onChange={onChange}
          />
        ))}
    </label>
  ),
  Tooltip: ({ children, title }: ContentProps & { title?: string }) => (
    <span title={title}>{children}</span>
  ),
  Typography: Content,
};

function DataTable<T>({
  rows,
  columns,
  getRowId,
  emptyTitle,
}: {
  rows: readonly T[];
  columns: readonly {
    id: string;
    label: ReactNode;
    render: (row: T, index: number) => ReactNode;
  }[];
  getRowId: (row: T) => Key;
  emptyTitle?: ReactNode;
}) {
  return (
    <div>
      {rows.length
        ? rows.map((row, index) => (
            <article key={getRowId(row)}>
              {columns.map((column) => (
                <div key={column.id}>
                  {column.label}
                  {column.render(row, index)}
                </div>
              ))}
            </article>
          ))
        : emptyTitle}
    </div>
  );
}

export const materialUiHelpers = {
  DataTable,
  DetailsGrid: ({
    items,
  }: {
    items: readonly { key?: string; label: ReactNode; value: ReactNode }[];
  }) => (
    <dl>
      {items.map((item, index) => (
        <div key={item.key ?? index}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  ),
  EmptyState: ({ title, description }: { title: ReactNode; description?: ReactNode }) => (
    <div>
      {title}
      {description}
    </div>
  ),
  notify: () => undefined,
};
