export interface ServerBindingSignerHostProfileV1 {
  readonly arguments: readonly string[];
  readonly executablePath: string;
  readonly workingDirectory: string;
}

/** Production remains unavailable until the separately reviewed B release and trust profile. */
export async function loadProductionServerBindingSignerHostProfileV1(): Promise<ServerBindingSignerHostProfileV1> {
  throw new Error("The production Server binding signer-host profile is unavailable.");
}

Object.freeze(loadProductionServerBindingSignerHostProfileV1);
