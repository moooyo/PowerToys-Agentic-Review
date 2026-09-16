import { timingSafeEqual } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type InvestigationPasswordDeriveKey,
  InvestigationPasswordKdf,
  InvestigationPasswordKdfError,
  investigationPasswordScryptParameters,
} from "../../dist/investigation/password-crypto.js";

vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  return { ...crypto, timingSafeEqual: vi.fn(crypto.timingSafeEqual) };
});

const password = "A sufficiently long password";
const testSalt = Buffer.alloc(16);
const testKey = Buffer.alloc(32);
const encodedParameters = "N=32768,r=8,p=3";

function encode(
  salt = testSalt.toString("base64"),
  key = testKey.toString("base64"),
  parameters = encodedParameters,
): string {
  return `$scrypt$${parameters}$${salt}$${key}`;
}

function fakeDeriver() {
  return vi.fn<InvestigationPasswordDeriveKey>(async () => Buffer.from(testKey));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function controlledDeriver() {
  const pending: ReturnType<typeof deferred<Buffer>>[] = [];
  const deriveKey = vi.fn<InvestigationPasswordDeriveKey>(() => {
    const result = deferred<Buffer>();
    pending.push(result);
    return result.promise;
  });
  return { deriveKey, pending };
}

function expectFixedCost(call: Parameters<InvestigationPasswordDeriveKey>) {
  expect(Buffer.isBuffer(call[1])).toBe(true);
  expect(call[1]).toHaveLength(16);
  expect(call[2]).toBe(32);
  expect(call[3]).toBe(investigationPasswordScryptParameters);
}

beforeEach(() => {
  vi.mocked(timingSafeEqual).mockClear();
});

describe("investigation password key derivation", () => {
  it("uses immutable fixed scrypt parameters and fresh canonical salts", async () => {
    expect(investigationPasswordScryptParameters).toEqual({
      N: 32768,
      r: 8,
      p: 3,
      maxmem: 64 * 1024 * 1024,
    });
    expect(Object.isFrozen(investigationPasswordScryptParameters)).toBe(true);
    const deriveKey = fakeDeriver();
    const kdf = new InvestigationPasswordKdf({ deriveKey });
    const first = await kdf.hash(password);
    const second = await kdf.hash(password);

    expect(deriveKey).toHaveBeenCalledTimes(2);
    for (const [index, encoded] of [first, second].entries()) {
      const call = deriveKey.mock.calls[index]!;
      expectFixedCost(call);
      expect(call[0]).toBe(password);
      expect(encoded.split("$")).toEqual([
        "",
        "scrypt",
        encodedParameters,
        call[1].toString("base64"),
        testKey.toString("base64"),
      ]);
      expect(encoded.split("$")[3]).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(encoded.split("$")[4]).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    }
    expect(deriveKey.mock.calls[0]![1]).not.toEqual(deriveKey.mock.calls[1]![1]);
  });

  it.each([
    ["15 ASCII code points", "a".repeat(15)],
    ["128 ASCII code points", "a".repeat(128)],
    ["15 supplementary code points", "\u{1F512}".repeat(15)],
    ["128 supplementary code points", "\u{1F512}".repeat(128)],
    ["untrimmed decomposed Unicode", "  Cafe\u0301 \u{1F512} password  "],
  ])("preserves %s through hashing and verification", async (_description, input) => {
    const deriveKey = fakeDeriver();
    const kdf = new InvestigationPasswordKdf({ deriveKey });
    const encoded = await kdf.hash(input);

    await expect(kdf.verify(input, encoded)).resolves.toBe(true);
    expect(deriveKey.mock.calls.map((call) => call[0])).toEqual([input, input]);
  });

  it.each([
    ["empty input", ""],
    ["15 ASCII spaces", " ".repeat(15)],
    ["15 Unicode spaces", "\u2003".repeat(15)],
    ["14 ASCII code points", "a".repeat(14)],
    ["129 ASCII code points", "a".repeat(129)],
    ["14 supplementary code points", "\u{1F512}".repeat(14)],
    ["129 supplementary code points", "\u{1F512}".repeat(129)],
    ["isolated high surrogate", `${"a".repeat(15)}\uD800`],
    ["isolated low surrogate", `${"a".repeat(15)}\uDC00`],
  ])("rejects hash creation for %s before deriving a key", async (_description, input) => {
    const deriveKey = fakeDeriver();
    const kdf = new InvestigationPasswordKdf({ deriveKey });
    const result = kdf.hash(input);

    await expect(result).rejects.toBeInstanceOf(InvestigationPasswordKdfError);
    await expect(result).rejects.toMatchObject({ code: "invalid_password", statusCode: 400 });
    expect(deriveKey).not.toHaveBeenCalled();
  });

  it("compares equal-length keys in constant time for both matches and mismatches", async () => {
    const deriveKey = fakeDeriver();
    deriveKey.mockResolvedValueOnce(Buffer.from(testKey));
    deriveKey.mockResolvedValueOnce(Buffer.alloc(32, 1));
    const kdf = new InvestigationPasswordKdf({ deriveKey });

    await expect(kdf.verify(password, encode())).resolves.toBe(true);
    await expect(kdf.verify(password, encode())).resolves.toBe(false);

    expect(deriveKey).toHaveBeenCalledTimes(2);
    for (const call of deriveKey.mock.calls) {
      expectFixedCost(call);
      expect(call[0]).toBe(password);
      expect(call[1]).toEqual(testSalt);
    }
    expect(timingSafeEqual).toHaveBeenCalledTimes(2);
    expect(timingSafeEqual).toHaveBeenNthCalledWith(1, testKey, testKey);
    expect(timingSafeEqual).toHaveBeenNthCalledWith(2, Buffer.alloc(32, 1), testKey);
  });

  it.each([
    ["unknown account", null],
    ["empty record", ""],
    ["unknown algorithm", encode().replace("$scrypt$", "$argon2$")],
    ["changed work factor", encode(undefined, undefined, "N=16384,r=8,p=3")],
    ["changed block size", encode(undefined, undefined, "N=32768,r=4,p=3")],
    ["changed parallelism", encode(undefined, undefined, "N=32768,r=8,p=1")],
    ["reordered parameters", encode(undefined, undefined, "r=8,N=32768,p=3")],
    ["noncanonical numeric parameter", encode(undefined, undefined, "N=032768,r=8,p=3")],
    ["additional parameter", encode(undefined, undefined, `${encodedParameters},x=1`)],
    ["missing leading delimiter", encode().slice(1)],
    ["additional field", `${encode()}$extra`],
    ["leading whitespace", ` ${encode()}`],
    ["trailing whitespace", `${encode()}\n`],
    ["missing salt", encode("")],
    ["short salt", encode(Buffer.alloc(15).toString("base64"))],
    ["long salt", encode(Buffer.alloc(17).toString("base64"))],
    ["unpadded salt", encode(testSalt.toString("base64").replace(/=+$/, ""))],
    ["noncanonical salt pad bits", encode(testSalt.toString("base64").replace(/A==$/, "B=="))],
    [
      "URL-safe salt",
      encode(Buffer.alloc(16, 251).toString("base64").replace(/\+/g, "-").replace(/\//g, "_")),
    ],
    ["invalid salt alphabet", encode(`!${testSalt.toString("base64").slice(1)}`)],
    ["salt whitespace", encode(` ${testSalt.toString("base64").slice(1)}`)],
    ["missing key", encode(undefined, "")],
    ["short key", encode(undefined, Buffer.alloc(31).toString("base64"))],
    ["long key", encode(undefined, Buffer.alloc(33).toString("base64"))],
    ["unpadded key", encode(undefined, testKey.toString("base64").replace(/=+$/, ""))],
    [
      "noncanonical key pad bits",
      encode(undefined, testKey.toString("base64").replace(/A=$/, "B=")),
    ],
    [
      "URL-safe key",
      encode(undefined, Buffer.alloc(32, 255).toString("base64").replace(/\//g, "_")),
    ],
    ["invalid key alphabet", encode(undefined, `!${testKey.toString("base64").slice(1)}`)],
  ])("performs one full-cost dummy comparison for %s", async (_description, encoded) => {
    const deriveKey = fakeDeriver();
    const kdf = new InvestigationPasswordKdf({ deriveKey });

    await expect(kdf.verify(password, encoded)).resolves.toBe(false);

    expect(deriveKey).toHaveBeenCalledTimes(1);
    expectFixedCost(deriveKey.mock.calls[0]!);
    expect(deriveKey.mock.calls[0]![0]).toBe(password);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
    const compared = vi.mocked(timingSafeEqual).mock.calls[0]!;
    expect(compared[0]).toHaveLength(32);
    expect(compared[1]).toHaveLength(32);
  });

  it("never authenticates a dummy comparison even if the derived key matches", async () => {
    const deriveKey = fakeDeriver();
    const kdf = new InvestigationPasswordKdf({ deriveKey });
    vi.mocked(timingSafeEqual).mockReturnValueOnce(true);

    await expect(kdf.verify(password, null)).resolves.toBe(false);
    expect(deriveKey).toHaveBeenCalledTimes(1);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
  });

  it("uses one fixed valid dummy password for invalid inputs without skipping work", async () => {
    const deriveKey = fakeDeriver();
    const kdf = new InvestigationPasswordKdf({ deriveKey });
    const invalidInputs = [
      "",
      " ".repeat(15),
      "\u2003".repeat(15),
      "a".repeat(14),
      "a".repeat(129),
      "\u{1F512}".repeat(14),
      `${"a".repeat(15)}\uD800`,
      `${"a".repeat(15)}\uDC00`,
    ];

    for (const encoded of [null, encode()]) {
      for (const input of invalidInputs) {
        await expect(kdf.verify(input, encoded)).resolves.toBe(false);
      }
    }

    expect(deriveKey).toHaveBeenCalledTimes(invalidInputs.length * 2);
    expect(timingSafeEqual).toHaveBeenCalledTimes(invalidInputs.length * 2);
    const dummyPassword = deriveKey.mock.calls[0]![0];
    expect(Array.from(dummyPassword).length).toBeGreaterThanOrEqual(15);
    expect(Array.from(dummyPassword).length).toBeLessThanOrEqual(128);
    expect(invalidInputs).not.toContain(dummyPassword);
    for (const call of deriveKey.mock.calls) {
      expectFixedCost(call);
      expect(call[0]).toBe(dummyPassword);
      expect(call[1]).toEqual(deriveKey.mock.calls[0]![1]);
    }
  });

  it("limits active work to two and queued work to eight by default", async () => {
    const { deriveKey, pending } = controlledDeriver();
    const kdf = new InvestigationPasswordKdf({ deriveKey });
    const results = Array.from({ length: 10 }, (_, index) => kdf.hash(`${password} ${index}`));
    await vi.waitFor(() => expect(deriveKey).toHaveBeenCalledTimes(2));

    const overflow = kdf.verify(password, null);
    await expect(overflow).rejects.toBeInstanceOf(InvestigationPasswordKdfError);
    await expect(overflow).rejects.toMatchObject({ code: "kdf_busy", statusCode: 429 });
    expect(deriveKey).toHaveBeenCalledTimes(2);

    for (let index = 0; index < results.length; index += 1) {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(index));
      pending[index]!.resolve(Buffer.from(testKey));
      await results[index];
      await vi.waitFor(() =>
        expect(deriveKey).toHaveBeenCalledTimes(Math.min(results.length, index + 3)),
      );
    }
    expect(deriveKey.mock.calls.map((call) => call[0])).toEqual(
      Array.from({ length: 10 }, (_, index) => `${password} ${index}`),
    );
  });

  it("shares a bounded FIFO queue between hash creation and verification", async () => {
    const { deriveKey, pending } = controlledDeriver();
    const kdf = new InvestigationPasswordKdf({ deriveKey, maxConcurrency: 1, maxQueue: 2 });
    const first = kdf.hash(`${password} first`);
    const second = kdf.verify(`${password} second`, encode());
    const third = kdf.hash(`${password} third`);
    await vi.waitFor(() => expect(deriveKey).toHaveBeenCalledTimes(1));

    await expect(kdf.hash(`${password} overflow`)).rejects.toMatchObject({
      code: "kdf_busy",
      statusCode: 429,
    });
    await expect(kdf.verify(password, null)).rejects.toMatchObject({
      code: "kdf_busy",
      statusCode: 429,
    });

    pending[0]!.resolve(Buffer.from(testKey));
    await first;
    await vi.waitFor(() => expect(deriveKey).toHaveBeenCalledTimes(2));
    expect(deriveKey.mock.calls[1]![0]).toBe(`${password} second`);
    pending[1]!.resolve(Buffer.from(testKey));
    await expect(second).resolves.toBe(true);
    await vi.waitFor(() => expect(deriveKey).toHaveBeenCalledTimes(3));
    expect(deriveKey.mock.calls[2]![0]).toBe(`${password} third`);
    pending[2]!.resolve(Buffer.from(testKey));
    await third;
    expect(deriveKey).toHaveBeenCalledTimes(3);
  });

  it("releases a failed derivation slot and continues queued work in order", async () => {
    const { deriveKey, pending } = controlledDeriver();
    const kdf = new InvestigationPasswordKdf({ deriveKey, maxConcurrency: 1, maxQueue: 2 });
    const failure = new Error("Derivation failed");
    const failed = expect(kdf.hash(`${password} first`)).rejects.toBe(failure);
    const second = kdf.verify(`${password} second`, encode());
    const third = kdf.hash(`${password} third`);
    await vi.waitFor(() => expect(deriveKey).toHaveBeenCalledTimes(1));

    pending[0]!.reject(failure);
    await failed;
    await vi.waitFor(() => expect(deriveKey).toHaveBeenCalledTimes(2));
    expect(deriveKey.mock.calls[1]![0]).toBe(`${password} second`);
    pending[1]!.resolve(Buffer.from(testKey));
    await expect(second).resolves.toBe(true);
    await vi.waitFor(() => expect(deriveKey).toHaveBeenCalledTimes(3));
    expect(deriveKey.mock.calls[2]![0]).toBe(`${password} third`);
    pending[2]!.resolve(Buffer.from(testKey));
    await third;
  });

  it("releases a slot when the derivation function throws synchronously", async () => {
    const failure = new Error("Synchronous derivation failure");
    const deriveKey = fakeDeriver();
    deriveKey.mockImplementationOnce(() => {
      throw failure;
    });
    const kdf = new InvestigationPasswordKdf({ deriveKey, maxConcurrency: 1, maxQueue: 0 });

    await expect(kdf.hash(password)).rejects.toBe(failure);
    await expect(kdf.verify(password, encode())).resolves.toBe(true);
    expect(deriveKey).toHaveBeenCalledTimes(2);
  });

  it("hashes and verifies with the default scrypt implementation", async () => {
    const kdf = new InvestigationPasswordKdf();
    const original = "  Cafe\u0301 password with spaces  ";
    const encoded = await kdf.hash(original);

    await expect(kdf.verify(original, encoded)).resolves.toBe(true);
    await expect(kdf.verify(original.normalize("NFC"), encoded)).resolves.toBe(false);
    await expect(kdf.verify(original.trim(), encoded)).resolves.toBe(false);
    await expect(kdf.verify("A different valid password", encoded)).resolves.toBe(false);
    await expect(kdf.verify(original, null)).resolves.toBe(false);
  }, 20_000);
});
