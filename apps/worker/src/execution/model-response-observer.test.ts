import { createHash } from "node:crypto";
import { createCanonicalResult } from "@agentic-review/codex";
import { describe, expect, it } from "vitest";
import {
  createModelResponseObserver,
  type ModelResponseObserverOptions,
  parseModelProtocolJson,
} from "./model-response-observer.js";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const options: ModelResponseObserverOptions = {
  format: "sse",
  maximumBodyBytes: 2 * 1024 * 1024,
  maximumEventBytes: 1024 * 1024,
  maximumEvents: 1024,
  maximumOutputTextBytes: 512 * 1024,
};
const message = (text = '{"z":2,"answer":"雪🌲"}') => ({
  id: "msg_fixture",
  type: "message",
  status: "completed",
  role: "assistant",
  content: [{ type: "output_text", text, annotations: [] }],
});
const response = (status = "completed", overrides: Record<string, unknown> = {}) => ({
  id: "resp_fixture_1",
  object: "response",
  created_at: 1740855869,
  status,
  model: "fixture-resolved-model-2026-09-08",
  error: null,
  incomplete_details: null,
  output: status === "completed" ? [message()] : [],
  ...overrides,
});
const frame = (value: unknown, name?: string) =>
  `${name === undefined ? "" : `event: ${name}\n`}data: ${JSON.stringify(value)}\n\n`;
const event = (type: string, sequence_number: number, extra: Record<string, unknown> = {}) => ({
  type,
  sequence_number,
  ...extra,
});
const terminal = (status = "completed", sequence = 0, overrides: Record<string, unknown> = {}) =>
  event(`response.${status}`, sequence, { response: response(status, overrides) });
function observe(
  body: string | Uint8Array,
  settings: Partial<ModelResponseObserverOptions> = {},
  complete = true,
  width?: number,
) {
  const observer = createModelResponseObserver({ ...options, ...settings });
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  const accepted: boolean[] = [];
  for (let offset = 0; offset < bytes.length; offset += width ?? bytes.length)
    accepted.push(observer.push(bytes.subarray(offset, offset + (width ?? bytes.length))));
  return { observer, accepted, result: observer.finish({ complete }), bytes };
}
function invalid(result: ReturnType<typeof observe>["result"], reasonCode: string) {
  expect(result).toMatchObject({
    outcome: "invalid",
    reasonCode,
    responseId: null,
    modelId: null,
    outputJsonSha256: null,
  });
}

// A protocol fixture, not a provider or model invocation. The terminal payload is authoritative;
// its intentionally different deltas must never be stitched into the output digest.
const realisticSse = [
  ": keep-alive\n\n",
  frame(event("response.created", 0, { response: response("in_progress") }), "response.created"),
  frame(event("response.in_progress", 1, { response: response("in_progress") })),
  frame(
    event("response.output_item.added", 2, {
      output_index: 0,
      item: {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    }),
  ),
  frame(
    event("response.content_part.added", 3, {
      item_id: "msg_fixture",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }),
  ),
  frame(
    event("response.output_text.delta", 4, {
      item_id: "msg_fixture",
      output_index: 0,
      content_index: 0,
      delta: "Not authoritative text",
    }),
  ),
  frame(
    event("response.output_text.done", 5, {
      item_id: "msg_fixture",
      output_index: 0,
      content_index: 0,
      text: '{"ignored":true}',
    }),
  ),
  frame(
    event("response.content_part.done", 6, {
      item_id: "msg_fixture",
      output_index: 0,
      content_index: 0,
      part: message().content[0],
    }),
  ),
  frame(event("response.output_item.done", 7, { output_index: 0, item: message() })),
  frame(terminal("completed", 8)),
  "data: [DONE]\n\n: ended\n",
].join("");

describe("model Responses body observation", () => {
  it.each([undefined, 1, 7, 257])(
    "observes the complete raw SSE body across byte chunks of %s",
    (width) => {
      const body = realisticSse.replaceAll("\n", "\r\n");
      const { result, bytes, accepted } = observe(body, {}, true, width);
      expect(accepted.every(Boolean)).toBe(true);
      expect(result).toEqual({
        schemaVersion: "ModelResponseObservationV1",
        bodySha256: hash(bytes),
        bodyBytes: bytes.length,
        eventCount: 9,
        transportComplete: true,
        outcome: "completed",
        responseId: "resp_fixture_1",
        modelId: "fixture-resolved-model-2026-09-08",
        outputJsonSha256: createCanonicalResult({ z: 2, answer: "雪🌲" }).sha256,
        reasonCode: null,
      });
    },
  );

  it("accepts multiline data, comments, SSE metadata and one leading UTF-8 BOM", () => {
    const json = JSON.stringify(terminal()).replace(',"response":', ',\n"response":');
    const body = `\uFEFF: ready\nretry: 1000\nid: stream-1\nevent: response.completed\n${json
      .split("\n")
      .map((line) => `data: ${line}\n`)
      .join("")}\n`;
    const { result } = observe(body, {}, true, 1);
    expect(result.outcome).toBe("completed");
    expect(result.eventCount).toBe(1);
    expect(result.bodySha256).toBe(hash(body));
  });

  it("accepts CR-only SSE line endings across individual-byte chunks", () => {
    const body = realisticSse.replaceAll("\n", "\r");
    const { result } = observe(body, {}, true, 1);
    expect(result).toMatchObject({
      outcome: "completed",
      eventCount: 9,
      bodyBytes: Buffer.byteLength(body),
      bodySha256: hash(body),
    });
  });

  it("accepts a complete non-streaming Response and canonicalizes split output_text content", () => {
    const output = [
      {
        ...message(),
        content: [
          { type: "output_text", text: '{"b":2,', annotations: [] },
          { type: "output_text", text: '"a":"雪"}', annotations: [] },
        ],
      },
    ];
    const { result } = observe(
      JSON.stringify(response("completed", { output })),
      { format: "json" },
      true,
      1,
    );
    expect(result).toMatchObject({
      outcome: "completed",
      eventCount: 1,
      outputJsonSha256: createCanonicalResult({ a: "雪", b: 2 }).sha256,
      reasonCode: null,
    });
  });

  it("uses only the final completed assistant message after previous output items", () => {
    const { result } = observe(
      frame(
        terminal("completed", 0, {
          output: [
            message('{"old":true}'),
            { type: "reasoning", id: "reasoning_1", summary: [] },
            message('{"final":true}'),
          ],
        }),
      ),
    );
    expect(result.outputJsonSha256).toBe(createCanonicalResult({ final: true }).sha256);
  });

  it.each([
    [
      "tool tail",
      [
        message(),
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "run",
          arguments: "{}",
          status: "completed",
        },
      ],
    ],
    [
      "refusal",
      [{ ...message(), content: [{ type: "refusal", refusal: "Private refusal details." }] }],
    ],
    [
      "mixed refusal",
      [
        {
          ...message(),
          content: [...message().content, { type: "refusal", refusal: "Private details." }],
        },
      ],
    ],
    ["unfinished message", [{ ...message(), status: "in_progress" }]],
    [
      "missing message status",
      [{ type: "message", role: "assistant", content: message().content }],
    ],
    ["non-assistant", [{ ...message(), role: "user" }]],
    ["non-JSON text", [message("Ordinary complete text.")]],
    ["empty output", []],
    ["empty content", [{ ...message(), content: [] }]],
    ["duplicate output keys", [message('{"answer":1,"answer":2}')]],
    ["malformed output Unicode", [message('"\\ud800"')]],
    ["nested output beyond limit", [message(`${"[".repeat(65)}0${"]".repeat(65)}`)]],
  ])("retains completed identity but no final JSON digest for %s", (_name, output) => {
    const { result } = observe(frame(terminal("completed", 0, { output })));
    expect(result).toMatchObject({
      outcome: "completed",
      responseId: "resp_fixture_1",
      modelId: "fixture-resolved-model-2026-09-08",
      outputJsonSha256: null,
      reasonCode: null,
    });
  });

  it.each(["failed", "incomplete"] as const)(
    "retains legitimate identity for a complete %s terminal without error text",
    (status) => {
      const { result } = observe(
        frame(
          terminal(status, 0, {
            error: { code: "server_error", message: "PRIVATE_PROVIDER_ERROR_CANARY" },
            incomplete_details: { reason: "max_output_tokens" },
          }),
        ),
      );
      expect(result).toMatchObject({
        outcome: status,
        responseId: "resp_fixture_1",
        modelId: "fixture-resolved-model-2026-09-08",
        outputJsonSha256: null,
        reasonCode: status === "failed" ? "RESPONSE_FAILED" : "RESPONSE_INCOMPLETE",
      });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_PROVIDER_ERROR_CANARY");
    },
  );

  it.each([
    ["starts at one", [terminal("completed", 1)]],
    [
      "gap",
      [
        event("response.created", 0, { response: response("in_progress") }),
        terminal("completed", 2),
      ],
    ],
    [
      "duplicate",
      [
        event("response.created", 0, { response: response("in_progress") }),
        terminal("completed", 0),
      ],
    ],
    ["negative", [terminal("completed", -1)]],
    ["fraction", [terminal("completed", 0.5)]],
    ["string", [{ ...terminal(), sequence_number: "0" }]],
    ["missing", [{ type: "response.completed", response: response() }]],
    [
      "late created",
      [
        event("response.output_text.delta", 0, { delta: "x" }),
        event("response.created", 1, { response: response("in_progress") }),
        terminal("completed", 2),
      ],
    ],
    [
      "back to queued",
      [
        event("response.in_progress", 0, { response: response("in_progress") }),
        event("response.queued", 1, { response: response("queued") }),
        terminal("completed", 2),
      ],
    ],
  ])("rejects the event sequence that %s", (_name, events) =>
    invalid(observe(events.map((value) => frame(value)).join("")).result, "INVALID_SEQUENCE"),
  );

  it.each([
    ["duplicate terminal", frame(terminal()) + frame(terminal("failed", 1))],
    [
      "post-terminal data",
      frame(terminal()) + frame(event("response.output_text.delta", 1, { delta: "x" })),
    ],
    ["DONE first", `data: [DONE]\n\n${frame(terminal())}`],
    ["DONE twice", `${frame(terminal())}data: [DONE]\n\ndata: [DONE]\n\n`],
    [
      "data after DONE",
      frame(terminal()) +
        "data: [DONE]\n\n" +
        frame(event("response.output_text.done", 1, { text: "{}" })),
    ],
  ])("does not accept %s", (_name, body) => invalid(observe(body).result, "INVALID_TERMINAL"));

  it.each(["id", "model"] as const)(
    "rejects conflicting %s across created and terminal response metadata",
    (field) => {
      const body =
        frame(event("response.created", 0, { response: response("in_progress") })) +
        frame(terminal("completed", 1, { [field]: "changed-identity" }));
      invalid(observe(body).result, "CONFLICTING_METADATA");
    },
  );
  it("checks optional response_id on intermediate events", () => {
    const body =
      frame(event("response.output_text.delta", 0, { response_id: "resp_other", delta: "x" })) +
      frame(terminal("completed", 1));
    invalid(observe(body).result, "CONFLICTING_METADATA");
  });

  it.each([
    { id: " resp_fixture_1" },
    { id: "resp_fixture_1\n" },
    { id: "resp\u0000id" },
    { id: "a".repeat(1025) },
    { id: null },
    { model: "" },
    { model: " model" },
    { model: "model\u0085name" },
    { model: "model\u2028name" },
    { model: "x".repeat(1025) },
    { model: null },
    { status: "failed" },
    { object: "other" },
  ])("rejects invalid terminal metadata %#", (overrides) =>
    invalid(observe(frame(terminal("completed", 0, overrides))).result, "INVALID_METADATA"),
  );

  it.each([
    ["sse", "id"],
    ["sse", "model"],
    ["json", "id"],
    ["json", "model"],
  ] as const)("rejects Unicode format controls in %s response.%s", (format, field) => {
    const overrides = { [field]: "a\u202eb" };
    const body =
      format === "sse"
        ? frame(terminal("completed", 0, overrides))
        : JSON.stringify(response("completed", overrides));
    invalid(observe(body, { format }).result, "INVALID_METADATA");
  });

  it.each([
    ["unknown event", frame(event("response.unsupported_provider_event", 0))],
    ["error event", frame(event("error", 0, { code: "private", message: "PRIVATE_ERROR" }))],
    ["missing response", frame(event("response.completed", 0))],
    [
      "metadata on unrelated event",
      frame(event("response.output_text.delta", 0, { response: response(), delta: "x" })),
    ],
  ])("rejects %s without inferring identity", (_name, body) =>
    invalid(observe(body).result, "INVALID_METADATA"),
  );

  it.each([
    ["event name mismatch", frame(terminal(), "response.failed")],
    [
      "duplicate event field",
      `event: response.completed\nevent: response.completed\n${frame(terminal())}`,
    ],
    ["unterminated terminal frame", frame(terminal()).slice(0, -1)],
    ["unknown SSE field", `provider: private\n${frame(terminal())}`],
    ["invalid retry", `retry: -1\n${frame(terminal())}`],
    ["NUL event ID", `id: private\u0000\n${frame(terminal())}`],
    ["embedded CR", `data: private\rtext\n\n${frame(terminal())}`],
  ])("rejects %s", (_name, body) => invalid(observe(body).result, "INVALID_SSE"));

  it("rejects a stream without a terminal event", () =>
    invalid(
      observe(frame(event("response.created", 0, { response: response("in_progress") }))).result,
      "MISSING_TERMINAL",
    ));
  it("rejects truncated transport even after receiving a completed terminal", () => {
    const { result } = observe(frame(terminal()), {}, false);
    invalid(result, "TRANSPORT_INCOMPLETE");
    expect(result.transportComplete).toBe(false);
  });
  it.each([
    Buffer.from([0xff]),
    Buffer.from([0xc0, 0xaf]),
    Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from([0xf0, 0x9f]),
  ])("rejects malformed or unfinished UTF-8 %#", (bytes) =>
    invalid(observe(bytes).result, "INVALID_UTF8"),
  );

  it("records the complete received overshoot chunk while releasing parser state", () => {
    const body = Buffer.from("x".repeat(65));
    const { result, accepted } = observe(body, {
      maximumBodyBytes: 64,
      maximumEventBytes: 64,
      maximumOutputTextBytes: 64,
    });
    expect(accepted).toEqual([false]);
    invalid(result, "BODY_LIMIT_EXCEEDED");
    expect(result.bodyBytes).toBe(65);
    expect(result.bodySha256).toBe(hash(body));
  });
  it("can report an invalid actual chunk beyond the global accepted body bound", () => {
    const body = Buffer.alloc(64 * 1024 * 1024 + 1, 0x20);
    const { result } = observe(body, { maximumBodyBytes: 64 * 1024 * 1024 });
    invalid(result, "BODY_LIMIT_EXCEEDED");
    expect(result.bodyBytes).toBe(body.length);
    expect(result.bodySha256).toBe(hash(body));
  });
  it("counts the first event over the configured limit accurately", () => {
    const body =
      frame(event("response.created", 0, { response: response("in_progress") })) +
      frame(terminal("completed", 1));
    const { result } = observe(body, { maximumEvents: 1 });
    invalid(result, "EVENT_LIMIT_EXCEEDED");
    expect(result.eventCount).toBe(2);
  });
  it("bounds a single SSE frame before it is parsed", () =>
    invalid(observe(frame(terminal()), { maximumEventBytes: 32 }).result, "EVENT_LIMIT_EXCEEDED"));
  it("bounds the UTF-8 output text instead of its UTF-16 length", () =>
    invalid(
      observe(frame(terminal("completed", 0, { output: [message('"雪雪雪"')] })), {
        maximumOutputTextBytes: 8,
      }).result,
      "OUTPUT_LIMIT_EXCEEDED",
    ));
  it("keeps the first invalid reason when the transport is then aborted", () => {
    const { result } = observe(Buffer.from([0xff]), {}, false);
    invalid(result, "INVALID_UTF8");
    expect(result.transportComplete).toBe(false);
  });
  it("rejects duplicate known metadata keys before JSON last-value semantics can apply", () => {
    const duplicate = JSON.stringify(response()).replace(
      '"model":"fixture-resolved-model-2026-09-08"',
      '"model":"first","\\u006dodel":"second"',
    );
    invalid(observe(duplicate, { format: "json" }).result, "AMBIGUOUS_JSON");
    invalid(
      observe(
        `data: {"type":"response.failed","type":"response.completed","sequence_number":0,"response":${JSON.stringify(response())}}\n\n`,
      ).result,
      "AMBIGUOUS_JSON",
    );
  });
  it("does not retain body text or provider error details in results or errors", () => {
    const privateText = "PRIVATE_PROVIDER_BODY_CANARY";
    const { result } = observe(`data: ${privateText}\n\n`);
    invalid(result, "INVALID_JSON");
    expect(JSON.stringify(result)).not.toContain(privateText);
    expect(() => parseModelProtocolJson(privateText)).toThrow(
      "The model protocol JSON could not be validated.",
    );
  });
  it("freezes completion and refuses later transport upgrades or pushes", () => {
    const { result, observer } = observe(frame(terminal()));
    expect(Object.isFrozen(result)).toBe(true);
    expect(observer.finish({ complete: true })).toBe(result);
    expect(() => observer.finish({ complete: false })).toThrow();
    expect(() => observer.push(Buffer.from("extra"))).toThrow();
  });
  it.each([
    { maximumBodyBytes: 0 },
    { maximumBodyBytes: 64 * 1024 * 1024 + 1 },
    { maximumEvents: 1_000_001 },
    { maximumEvents: 1.5 },
    { maximumEventBytes: 3 * 1024 * 1024 },
    { maximumOutputTextBytes: 0 },
    { format: "unsupported" },
  ])("rejects invalid observer configuration %#", (overrides) =>
    expect(() =>
      createModelResponseObserver({ ...options, ...overrides } as ModelResponseObserverOptions),
    ).toThrow(TypeError),
  );
});

describe("bounded model protocol JSON", () => {
  it.each([
    '{"model":"fixture","stream":true,"input":[{"role":"user","content":"雪"}]}',
    ' [1,-0,2.5,3e2,true,false,null,"\\uD83C\\uDF32"] ',
  ])("preserves valid JSON semantics for %s", (text) =>
    expect(parseModelProtocolJson(text)).toEqual(JSON.parse(text)),
  );
  it.each([
    '{"model":"a","model":"b"}',
    '{"stream":true,"\\u0073tream":false}',
    '{"nested":{"id":"a","id":"b"}}',
  ])("rejects duplicate decoded keys in %s", (text) =>
    expect(() => parseModelProtocolJson(text)).toThrow(
      expect.objectContaining({ code: "AMBIGUOUS_JSON" }),
    ),
  );
  it.each([
    "",
    "{}{}",
    "[1,]",
    '{"a":1,}',
    "01",
    "+1",
    "NaN",
    "1e999",
    '"\\ud800"',
    '"\\udc00"',
    '"\ud800"',
    '\uFEFF{"model":"a"}',
    '{"x":"bad\nstring"}',
    '{"x":"\\q"}',
    '"unfinished',
  ])("rejects malformed JSON %# with a fixed error", (text) =>
    expect(() => parseModelProtocolJson(text)).toThrow(
      expect.objectContaining({
        code: "INVALID_JSON",
        message: "The model protocol JSON could not be validated.",
      }),
    ),
  );
  it("bounds nesting and JSON node count", () => {
    expect(() => parseModelProtocolJson(`${"[".repeat(64)}0${"]".repeat(64)}`)).not.toThrow();
    expect(() => parseModelProtocolJson(`${"[".repeat(65)}0${"]".repeat(65)}`)).toThrow(
      expect.objectContaining({ code: "JSON_COMPLEXITY_EXCEEDED" }),
    );
    expect(() =>
      parseModelProtocolJson(`[${Array.from({ length: 100_000 }, () => "null").join(",")}]`),
    ).toThrow(expect.objectContaining({ code: "JSON_COMPLEXITY_EXCEEDED" }));
  });
  it("does not let a JSON __proto__ key alter object prototypes", () => {
    const value = parseModelProtocolJson('{"__proto__":{"model":"fake"},"model":"real"}') as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(value.model).toBe("real");
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
  });
});
