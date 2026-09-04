import { CloneType, type Static, type TObject, type TSchema, Type } from "@sinclair/typebox";

import {
  type DecodedLocalFrame,
  type EncodeLocalFrameInput,
  encodeLocalFrame,
  IncrementalLocalFrameDecoder,
  LocalMessageType,
  type LocalMessageTypeId,
  LocalProtocolError,
  type LocalProtocolSequence,
} from "./framing.js";
import {
  ArtifactChunkMessageSchema,
  ArtifactEndMessageSchema,
  ArtifactStartMessageSchema,
  CancelAckMessageSchema,
  CancelAttemptMessageSchema,
  CompleteMessageSchema,
  DrainedMessageSchema,
  DrainMessageSchema,
  FailedMessageSchema,
  HelloAckMessageSchema,
  HelloMessageSchema,
  PingMessageSchema,
  PongMessageSchema,
  ProgressMessageSchema,
  ReadyMessageSchema,
  RenewGrantMessageSchema,
  StartAttemptMessageSchema,
  TerminalAckMessageSchema,
  TerminalDispositionMessageSchema,
} from "./messages.js";

export const LOCAL_PROTOCOL_MINOR_1_VERSION = 1 as const;

const Minor1Sha256Schema = Type.String({
  minLength: 64,
  maxLength: 64,
  pattern: "^[a-f0-9]{64}$",
});

const withProtocolMinorOne = <TSchemaValue extends TObject>(schema: TSchemaValue) =>
  freezeSchema(
    Type.Composite(
      [
        Type.Omit(CloneType(schema), ["protocolMinor"]),
        Type.Object(
          { protocolMinor: Type.Literal(LOCAL_PROTOCOL_MINOR_1_VERSION) },
          { additionalProperties: false },
        ),
      ],
      { additionalProperties: false },
    ),
  );

export const HelloMessageMinor1Schema = freezeSchema(
  Type.Composite(
    [
      Type.Omit(CloneType(HelloMessageSchema), ["minimumMinor", "maximumMinor"]),
      Type.Object(
        {
          minimumMinor: Type.Literal(LOCAL_PROTOCOL_MINOR_1_VERSION),
          maximumMinor: Type.Literal(LOCAL_PROTOCOL_MINOR_1_VERSION),
        },
        { additionalProperties: false },
      ),
    ],
    { additionalProperties: false },
  ),
);
export type HelloMessageMinor1 = Static<typeof HelloMessageMinor1Schema>;

export const HelloAckMessageMinor1Schema = withProtocolMinorOne(HelloAckMessageSchema);
export type HelloAckMessageMinor1 = Static<typeof HelloAckMessageMinor1Schema>;

export const ReadyMessageMinor1Schema = withProtocolMinorOne(ReadyMessageSchema);
export const StartAttemptMessageMinor1Schema = withProtocolMinorOne(StartAttemptMessageSchema);
export const RenewGrantMessageMinor1Schema = withProtocolMinorOne(RenewGrantMessageSchema);
export const CancelAttemptMessageMinor1Schema = withProtocolMinorOne(CancelAttemptMessageSchema);
export const CancelAckMessageMinor1Schema = withProtocolMinorOne(CancelAckMessageSchema);
export const ProgressMessageMinor1Schema = withProtocolMinorOne(ProgressMessageSchema);
export const ArtifactStartMessageMinor1Schema = withProtocolMinorOne(ArtifactStartMessageSchema);
export const ArtifactChunkMessageMinor1Schema = withProtocolMinorOne(ArtifactChunkMessageSchema);
export const ArtifactEndMessageMinor1Schema = withProtocolMinorOne(ArtifactEndMessageSchema);

export const CompleteMessageMinor1Schema = freezeSchema(
  Type.Composite(
    [
      Type.Omit(CloneType(CompleteMessageSchema), ["protocolMinor"]),
      Type.Object(
        {
          protocolMinor: Type.Literal(LOCAL_PROTOCOL_MINOR_1_VERSION),
          resultDigest: Minor1Sha256Schema,
        },
        { additionalProperties: false },
      ),
    ],
    { additionalProperties: false },
  ),
);
export type CompleteMessageMinor1 = Static<typeof CompleteMessageMinor1Schema>;

export const FailedMessageMinor1Schema = withProtocolMinorOne(FailedMessageSchema);
export const DrainMessageMinor1Schema = withProtocolMinorOne(DrainMessageSchema);
export const DrainedMessageMinor1Schema = withProtocolMinorOne(DrainedMessageSchema);
export const PingMessageMinor1Schema = withProtocolMinorOne(PingMessageSchema);
export const PongMessageMinor1Schema = withProtocolMinorOne(PongMessageSchema);
export const TerminalDispositionMessageMinor1Schema = withProtocolMinorOne(
  TerminalDispositionMessageSchema,
);
export const TerminalAckMessageMinor1Schema = withProtocolMinorOne(TerminalAckMessageSchema);

export const localMessageSchemasMinor1 = Object.freeze({
  [LocalMessageType.Hello]: HelloMessageMinor1Schema,
  [LocalMessageType.HelloAck]: HelloAckMessageMinor1Schema,
  [LocalMessageType.Ready]: ReadyMessageMinor1Schema,
  [LocalMessageType.StartAttempt]: StartAttemptMessageMinor1Schema,
  [LocalMessageType.RenewGrant]: RenewGrantMessageMinor1Schema,
  [LocalMessageType.CancelAttempt]: CancelAttemptMessageMinor1Schema,
  [LocalMessageType.CancelAck]: CancelAckMessageMinor1Schema,
  [LocalMessageType.Progress]: ProgressMessageMinor1Schema,
  [LocalMessageType.ArtifactStart]: ArtifactStartMessageMinor1Schema,
  [LocalMessageType.ArtifactChunk]: ArtifactChunkMessageMinor1Schema,
  [LocalMessageType.ArtifactEnd]: ArtifactEndMessageMinor1Schema,
  [LocalMessageType.Complete]: CompleteMessageMinor1Schema,
  [LocalMessageType.Failed]: FailedMessageMinor1Schema,
  [LocalMessageType.Drain]: DrainMessageMinor1Schema,
  [LocalMessageType.Drained]: DrainedMessageMinor1Schema,
  [LocalMessageType.Ping]: PingMessageMinor1Schema,
  [LocalMessageType.Pong]: PongMessageMinor1Schema,
  [LocalMessageType.TerminalDisposition]: TerminalDispositionMessageMinor1Schema,
  [LocalMessageType.TerminalAck]: TerminalAckMessageMinor1Schema,
} satisfies Record<LocalMessageTypeId, TSchema>);

export type LocalMessagePayloadMinor1 = Static<
  (typeof localMessageSchemasMinor1)[LocalMessageTypeId]
>;

export type EncodeLocalFrameMinor1Input = Omit<EncodeLocalFrameInput, "minorVersion">;
export type DecodedLocalFrameMinor1 = Omit<DecodedLocalFrame, "minorVersion"> & {
  readonly minorVersion: typeof LOCAL_PROTOCOL_MINOR_1_VERSION;
};

export function encodeLocalFrameMinor1(input: EncodeLocalFrameMinor1Input): Buffer {
  return encodeLocalFrame({
    correlationId: input.correlationId,
    messageType: input.messageType,
    minorVersion: LOCAL_PROTOCOL_MINOR_1_VERSION,
    payload: input.payload,
    sequence: input.sequence,
  });
}

export function decodeLocalFrameMinor1(
  bytes: Uint8Array,
  expectedSequence: LocalProtocolSequence = 1n,
): DecodedLocalFrameMinor1 {
  const decoder = new IncrementalLocalFrameDecoder({
    minorVersion: LOCAL_PROTOCOL_MINOR_1_VERSION,
    expectedSequence,
  });
  const frames = decoder.push(bytes);
  decoder.end();
  if (frames.length !== 1 || frames[0]?.minorVersion !== LOCAL_PROTOCOL_MINOR_1_VERSION) {
    throw new LocalProtocolError("ARWX protocol minor 1 requires exactly one complete frame.");
  }
  return frames[0] as DecodedLocalFrameMinor1;
}

function freezeSchema<TSchemaValue extends TSchema>(schema: TSchemaValue): TSchemaValue {
  const visited = new WeakSet<object>();
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && Object.hasOwn(descriptor, "value")) {
        freeze(descriptor.value);
      }
    }
    Object.freeze(value);
  };
  freeze(schema);
  return schema;
}
