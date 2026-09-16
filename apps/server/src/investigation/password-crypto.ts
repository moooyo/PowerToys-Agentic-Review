import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { InvestigationNewPasswordSchema } from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";

export const investigationPasswordScryptParameters = Object.freeze({
  N: 32768,
  r: 8,
  p: 3,
  maxmem: 64 * 1024 * 1024,
});

const saltLength = 16;
const keyLength = 32;
const encodedParameters = "N=32768,r=8,p=3";
const dummyPassword = "Invalid password verification input";

export type InvestigationPasswordDeriveKey = (
  password: string,
  salt: Buffer,
  length: number,
  parameters: Readonly<typeof investigationPasswordScryptParameters>,
) => Promise<Buffer>;

export class InvestigationPasswordKdfError extends Error {
  readonly statusCode: 429 | 400;

  constructor(readonly code: "kdf_busy" | "invalid_password") {
    super(
      code === "kdf_busy"
        ? "Password authentication is busy. Try again later."
        : "Passwords must contain between 15 and 128 Unicode code points and a non-whitespace character.",
    );
    this.name = "InvestigationPasswordKdfError";
    this.statusCode = code === "kdf_busy" ? 429 : 400;
  }
}

function validPassword(password: string): boolean {
  return Value.Check(InvestigationNewPasswordSchema, password);
}

function decodeCanonicalBase64(value: string, length: number): Buffer | null {
  const decoded = Buffer.from(value, "base64");
  return decoded.length === length && decoded.toString("base64") === value ? decoded : null;
}

function parsePasswordHash(encoded: string | null): { salt: Buffer; key: Buffer } | null {
  if (typeof encoded !== "string") return null;
  const parts = encoded.split("$");
  if (
    parts.length !== 5 ||
    parts[0] !== "" ||
    parts[1] !== "scrypt" ||
    parts[2] !== encodedParameters ||
    parts[3]?.length !== 24 ||
    parts[4]?.length !== 44
  ) {
    return null;
  }
  const salt = decodeCanonicalBase64(parts[3], saltLength);
  const key = decodeCanonicalBase64(parts[4], keyLength);
  return salt === null || key === null ? null : { salt, key };
}

const deriveScryptKey: InvestigationPasswordDeriveKey = (password, salt, length, parameters) =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, length, parameters, (error, key) => {
      if (error !== null) reject(error);
      else resolve(key);
    });
  });

export class InvestigationPasswordKdf {
  readonly #maxConcurrency: number;
  readonly #maxQueue: number;
  readonly #deriveKey: InvestigationPasswordDeriveKey;
  readonly #dummySalt = randomBytes(saltLength);
  readonly #dummyKey = randomBytes(keyLength);
  readonly #queue: Array<() => void> = [];
  #active = 0;

  constructor(
    options: {
      maxConcurrency?: number;
      maxQueue?: number;
      deriveKey?: InvestigationPasswordDeriveKey;
    } = {},
  ) {
    this.#maxConcurrency = options.maxConcurrency ?? 2;
    this.#maxQueue = options.maxQueue ?? 8;
    if (!Number.isSafeInteger(this.#maxConcurrency) || this.#maxConcurrency < 1) {
      throw new RangeError("Password KDF concurrency must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(this.#maxQueue) || this.#maxQueue < 0) {
      throw new RangeError("Password KDF queue size must be a nonnegative safe integer.");
    }
    this.#deriveKey = options.deriveKey ?? deriveScryptKey;
  }

  async hash(password: string): Promise<string> {
    if (!validPassword(password)) throw new InvestigationPasswordKdfError("invalid_password");
    const salt = randomBytes(saltLength);
    const key = await this.#derive(password, salt);
    return `$scrypt$${encodedParameters}$${salt.toString("base64")}$${key.toString("base64")}`;
  }

  async verify(password: string, encoded: string | null): Promise<boolean> {
    const passwordIsValid = validPassword(password);
    const parsed = parsePasswordHash(encoded);
    const useStoredHash = passwordIsValid && parsed !== null;
    const key = await this.#derive(
      passwordIsValid ? password : dummyPassword,
      useStoredHash ? parsed.salt : this.#dummySalt,
    );
    const matches = timingSafeEqual(key, useStoredHash ? parsed.key : this.#dummyKey);
    return useStoredHash && matches;
  }

  #acquire(): Promise<void> {
    if (this.#active < this.#maxConcurrency) {
      this.#active += 1;
      return Promise.resolve();
    }
    if (this.#queue.length >= this.#maxQueue) {
      return Promise.reject(new InvestigationPasswordKdfError("kdf_busy"));
    }
    return new Promise((resolve) => this.#queue.push(resolve));
  }

  async #derive(password: string, salt: Buffer): Promise<Buffer> {
    await this.#acquire();
    try {
      const key = await this.#deriveKey(
        password,
        salt,
        keyLength,
        investigationPasswordScryptParameters,
      );
      if (!Buffer.isBuffer(key) || key.length !== keyLength) {
        throw new Error("Password key derivation returned an invalid key.");
      }
      return key;
    } finally {
      const next = this.#queue.shift();
      if (next === undefined) this.#active -= 1;
      else next();
    }
  }
}
