/** Independently compiled public trust used to verify the production Server binding signer. */
export interface ProductionServerBindingTrustProfileV1 {
  readonly compiledTrustedIssuerPublicKeySpki: Uint8Array;
}

/**
 * Production trust remains unavailable until a later decision supplies a signed, compiled trust
 * artifact. This module is intentionally independent from the private-key provider loader.
 */
export async function loadProductionServerBindingTrustProfileV1(): Promise<
  Readonly<ProductionServerBindingTrustProfileV1>
> {
  throw new Error("The production Server binding trust profile is unavailable.");
}

Object.freeze(loadProductionServerBindingTrustProfileV1);
