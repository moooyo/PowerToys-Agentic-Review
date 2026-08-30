export const asFilterValue = (value: unknown): string | string[] | undefined => {
  if (Array.isArray(value)) {
    return value.map(String);
  }

  return typeof value === "string" ? value : undefined;
};

export const asSearchValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
