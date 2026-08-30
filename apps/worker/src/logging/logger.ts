export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

type LogLevel = "debug" | "info" | "warn" | "error";

const levelPriority: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class ConsoleJsonLogger implements Logger {
  readonly #minimumPriority: number;
  readonly #baseFields: LogFields;

  public constructor(level: LogLevel, baseFields: LogFields = {}) {
    this.#minimumPriority = levelPriority[level];
    this.#baseFields = baseFields;
  }

  public debug(message: string, fields?: LogFields): void {
    this.#write("debug", message, fields);
  }

  public info(message: string, fields?: LogFields): void {
    this.#write("info", message, fields);
  }

  public warn(message: string, fields?: LogFields): void {
    this.#write("warn", message, fields);
  }

  public error(message: string, fields?: LogFields): void {
    this.#write("error", message, fields);
  }

  #write(level: LogLevel, message: string, fields?: LogFields): void {
    if (levelPriority[level] < this.#minimumPriority) {
      return;
    }

    const serialized = JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        level,
        message,
        ...this.#baseFields,
        ...fields,
      },
      (_key, value: unknown) =>
        value instanceof Error
          ? { name: value.name, message: value.message, stack: value.stack, cause: value.cause }
          : value,
    );

    if (level === "error") {
      console.error(serialized);
    } else if (level === "warn") {
      console.warn(serialized);
    } else {
      console.log(serialized);
    }
  }
}
