import { describe, expect, it } from "vitest";
import { completeLegacyDatabaseAdoption } from "../../dist/database/database-initialization.js";
import type { MigrationState } from "../../dist/database/migrations.js";

const pendingMigrationState: MigrationState = {
  currentVersion: 1,
  targetVersion: 2,
  pendingVersions: [2],
};

describe("completeLegacyDatabaseAdoption", () => {
  it("publishes the initialized marker only after validation and a durable backup", async () => {
    const events: string[] = [];
    const result = await completeLegacyDatabaseAdoption({
      setTrustedSchemaOff: () => events.push("trusted-schema-off"),
      verifyIntegrity: () => events.push("integrity"),
      verifyForeignKeys: () => events.push("foreign-keys"),
      inspectKnownMigrationState: () => {
        events.push("inspect-migrations");
        return pendingMigrationState;
      },
      assertDatabaseIdentity: () => events.push("assert-identity"),
      cleanupIncompleteBackups: () => events.push("cleanup-backups"),
      createBackup: async () => {
        events.push("backup-start");
        await Promise.resolve();
        events.push("backup-durable");
      },
      consumeLegacyAdoptionAuthorization: () => events.push("consume-authorization"),
      publishInitializedMarker: () => events.push("publish-marker"),
    });

    expect(result).toBe(pendingMigrationState);
    expect(events).toEqual([
      "assert-identity",
      "trusted-schema-off",
      "integrity",
      "foreign-keys",
      "inspect-migrations",
      "assert-identity",
      "cleanup-backups",
      "backup-start",
      "backup-durable",
      "assert-identity",
      "consume-authorization",
      "publish-marker",
    ]);
  });

  it("does not publish the marker when validation or backup fails", async () => {
    const integrityError = new Error("integrity failed");
    const integrityEvents: string[] = [];
    await expect(
      completeLegacyDatabaseAdoption({
        setTrustedSchemaOff: () => integrityEvents.push("trusted-schema-off"),
        verifyIntegrity: () => {
          integrityEvents.push("integrity");
          throw integrityError;
        },
        verifyForeignKeys: () => integrityEvents.push("foreign-keys"),
        inspectKnownMigrationState: () => pendingMigrationState,
        assertDatabaseIdentity: () => integrityEvents.push("assert-identity"),
        cleanupIncompleteBackups: () => integrityEvents.push("cleanup-backups"),
        createBackup: async () => undefined,
        consumeLegacyAdoptionAuthorization: () => integrityEvents.push("consume-authorization"),
        publishInitializedMarker: () => integrityEvents.push("publish-marker"),
      }),
    ).rejects.toBe(integrityError);
    expect(integrityEvents).toEqual(["assert-identity", "trusted-schema-off", "integrity"]);

    const backupError = new Error("backup failed");
    const backupEvents: string[] = [];
    await expect(
      completeLegacyDatabaseAdoption({
        setTrustedSchemaOff: () => backupEvents.push("trusted-schema-off"),
        verifyIntegrity: () => backupEvents.push("integrity"),
        verifyForeignKeys: () => backupEvents.push("foreign-keys"),
        inspectKnownMigrationState: () => pendingMigrationState,
        assertDatabaseIdentity: () => backupEvents.push("assert-identity"),
        cleanupIncompleteBackups: () => backupEvents.push("cleanup-backups"),
        createBackup: async () => {
          backupEvents.push("backup");
          throw backupError;
        },
        consumeLegacyAdoptionAuthorization: () => backupEvents.push("consume-authorization"),
        publishInitializedMarker: () => backupEvents.push("publish-marker"),
      }),
    ).rejects.toBe(backupError);
    expect(backupEvents).not.toContain("publish-marker");
  });

  it("does not publish without successful authorization consumption and cannot undo consumption", async () => {
    const currentMigrationState: MigrationState = {
      currentVersion: 2,
      targetVersion: 2,
      pendingVersions: [],
    };
    const consumeError = new Error("authorization consumption failed");
    const consumeEvents: string[] = [];
    await expect(
      completeLegacyDatabaseAdoption({
        assertDatabaseIdentity: () => consumeEvents.push("assert-identity"),
        setTrustedSchemaOff: () => consumeEvents.push("trusted-schema-off"),
        verifyIntegrity: () => consumeEvents.push("integrity"),
        verifyForeignKeys: () => consumeEvents.push("foreign-keys"),
        inspectKnownMigrationState: () => currentMigrationState,
        cleanupIncompleteBackups: () => consumeEvents.push("cleanup-backups"),
        createBackup: async () => undefined,
        consumeLegacyAdoptionAuthorization: () => {
          consumeEvents.push("consume-authorization");
          throw consumeError;
        },
        publishInitializedMarker: () => consumeEvents.push("publish-marker"),
      }),
    ).rejects.toBe(consumeError);
    expect(consumeEvents).not.toContain("publish-marker");

    const markerError = new Error("marker creation failed");
    const markerEvents: string[] = [];
    await expect(
      completeLegacyDatabaseAdoption({
        assertDatabaseIdentity: () => markerEvents.push("assert-identity"),
        setTrustedSchemaOff: () => markerEvents.push("trusted-schema-off"),
        verifyIntegrity: () => markerEvents.push("integrity"),
        verifyForeignKeys: () => markerEvents.push("foreign-keys"),
        inspectKnownMigrationState: () => currentMigrationState,
        cleanupIncompleteBackups: () => markerEvents.push("cleanup-backups"),
        createBackup: async () => undefined,
        consumeLegacyAdoptionAuthorization: () => markerEvents.push("consume-authorization"),
        publishInitializedMarker: () => {
          markerEvents.push("publish-marker");
          throw markerError;
        },
      }),
    ).rejects.toBe(markerError);
    expect(markerEvents.slice(-2)).toEqual(["consume-authorization", "publish-marker"]);
  });
});
