import { ArtifactStorageIntegrityError } from "./errors.js";

export interface ArtifactEntryReader<T> {
  read(): T | null;
  close(): void;
}

export class ArtifactEntryBudget {
  readonly #maximumEntries: number;
  #consumedEntries = 0;

  constructor(maximumEntries: number) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new TypeError("Artifact storage scan entry budget must be positive.");
    }
    this.#maximumEntries = maximumEntries;
  }

  get consumedEntries(): number {
    return this.#consumedEntries;
  }

  consume(): void {
    this.#consumedEntries += 1;
    if (this.#consumedEntries > this.#maximumEntries) {
      throw new ArtifactStorageIntegrityError(
        "Artifact storage managed entry count exceeds its bounded scan budget.",
      );
    }
  }
}

export const visitBoundedArtifactEntries = <T>(
  reader: ArtifactEntryReader<T>,
  budget: ArtifactEntryBudget,
  visit: (entry: T) => void,
): void => {
  let operationError: unknown;
  try {
    for (let entry = reader.read(); entry !== null; entry = reader.read()) {
      budget.consume();
      visit(entry);
    }
  } catch (error) {
    operationError = error;
  }

  let closeError: unknown;
  try {
    reader.close();
  } catch (error) {
    closeError = error;
  }
  if (operationError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [operationError, closeError],
      "Artifact directory scan and close both failed.",
      { cause: operationError },
    );
  }
  if (operationError !== undefined) {
    throw operationError;
  }
  if (closeError !== undefined) {
    throw closeError;
  }
};
