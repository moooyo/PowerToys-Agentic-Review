export interface ClosableDatabase {
  close(): void;
}

export interface AsyncClosableDatabaseResource {
  close(): Promise<void>;
}

export const completeDatabaseShutdown = (
  database: ClosableDatabase,
  onClosed: () => void,
  onError: (error: unknown) => void,
): void => {
  try {
    database.close();
  } catch (error) {
    onError(error);
    return;
  }
  onClosed();
};

export const closeDatabaseStorage = async (
  database: AsyncClosableDatabaseResource | undefined,
  ownerLock: AsyncClosableDatabaseResource | undefined,
): Promise<void> => {
  let databaseError: unknown;
  try {
    await database?.close();
  } catch (error) {
    databaseError = error;
  }

  let ownerLockError: unknown;
  try {
    await ownerLock?.close();
  } catch (error) {
    ownerLockError = error;
  }

  if (databaseError !== undefined && ownerLockError !== undefined) {
    throw new AggregateError(
      [databaseError, ownerLockError],
      "Database client and database owner lock shutdown both failed.",
      { cause: databaseError },
    );
  }
  if (databaseError !== undefined) {
    throw databaseError;
  }
  if (ownerLockError !== undefined) {
    throw ownerLockError;
  }
};
