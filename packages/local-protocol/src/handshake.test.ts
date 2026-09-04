import { describe, expect, it } from "vitest";
import {
  establishLocalSession,
  isEstablishedLocalSession,
  LocalHandshakeError,
  validateReadyForEstablishedSession,
} from "./handshake.js";
import type { HelloAckMessage, HelloMessage, ReadyMessage } from "./messages.js";

const hex = (character: string): string => character.repeat(64);

const hello: HelloMessage = {
  protocolMajor: 1,
  minimumMinor: 0,
  maximumMinor: 0,
  workerNodeId: "powertoys-node-01",
  workerInstanceId: "worker-instance:restart-7",
  executorBootId: null,
  sessionId: "10000000-0000-4000-8000-000000000001",
  controlNonce: hex("1"),
};

const helloAck: HelloAckMessage = {
  protocolMajor: 1,
  protocolMinor: 0,
  workerNodeId: hello.workerNodeId,
  workerInstanceId: hello.workerInstanceId,
  executorBootId: "20000000-0000-4000-8000-000000000002",
  sessionId: hello.sessionId,
  controlNonce: hello.controlNonce,
  executorNonce: hex("4"),
  maximumSlots: 4,
};

describe("plain local handshake", () => {
  it("establishes a frozen runtime-branded session from Hello and HelloAck", () => {
    const session = establishLocalSession(hello, helloAck);

    expect(session).toEqual({ hello, helloAck });
    expect(isEstablishedLocalSession(session)).toBe(true);
    expect(isEstablishedLocalSession({ hello, helloAck })).toBe(false);
    expect(Object.isFrozen(session.helloAck)).toBe(true);
  });

  it("rejects mismatched protocol, identity, nonce, and empty evidence", () => {
    const mutations: ReadonlyArray<Partial<HelloAckMessage>> = [
      { protocolMajor: 2 as 1 },
      { workerNodeId: "other-node" },
      { workerInstanceId: "other-instance" },
      { sessionId: "30000000-0000-4000-8000-000000000003" },
      { controlNonce: hex("8") },
      { executorNonce: hello.controlNonce },
    ];

    for (const mutation of mutations) {
      expect(() => establishLocalSession(hello, { ...helloAck, ...mutation })).toThrow(
        LocalHandshakeError,
      );
    }
  });

  it("validates Ready against every established Executor session field", () => {
    const session = establishLocalSession(hello, helloAck);
    const ready = readyMessage();

    expect(validateReadyForEstablishedSession(ready, session)).toEqual(ready);
    for (const invalid of [
      { ...ready, executorBootId: "30000000-0000-4000-8000-000000000003" },
      { ...ready, executorNonce: hex("8") },
      { ...ready, availableSlots: helloAck.maximumSlots + 1 },
    ]) {
      expect(() => validateReadyForEstablishedSession(invalid, session)).toThrowError(
        expect.objectContaining({ code: "HANDSHAKE_CONTEXT_MISMATCH" }),
      );
    }
  });

  it("rejects an unbranded session object", () => {
    expect(() =>
      validateReadyForEstablishedSession(readyMessage(), { hello, helloAck } as ReturnType<
        typeof establishLocalSession
      >),
    ).toThrowError(expect.objectContaining({ code: "HANDSHAKE_CONTEXT_MISMATCH" }));
  });
});

function readyMessage(): ReadyMessage {
  return {
    protocolMajor: helloAck.protocolMajor,
    protocolMinor: helloAck.protocolMinor,
    workerNodeId: helloAck.workerNodeId,
    workerInstanceId: helloAck.workerInstanceId,
    executorBootId: helloAck.executorBootId,
    sessionId: helloAck.sessionId,
    controlNonce: helloAck.controlNonce,
    executorNonce: helloAck.executorNonce,
    isolationMode: "split-service-v1",
    ready: true,
    availableSlots: helloAck.maximumSlots,
    reasonCode: null,
  };
}
