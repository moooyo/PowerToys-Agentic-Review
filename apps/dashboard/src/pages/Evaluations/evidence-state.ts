import type * as C from "@agentic-review/contracts";
import type { EvaluationEvidenceAdapter } from "@/services/evaluation-evidence";
import {
  evaluationEvidenceBindingKeys,
  evaluationEvidenceBindingMatches,
} from "@/services/evaluation-evidence";
import {
  ReviewControlHttpError,
  ReviewControlProtocolError,
} from "@/services/review-control/errors";
import { errorMessage } from "./state";

export const maximumEvidenceTextPreviewBytes = 64 * 1024;
export type EvaluationEvidenceReference = { assetId: string; checkIds: string[] };
export function resultEvidenceBinding(
  result: C.EvaluationCellResultV1,
): C.EvaluationEvidenceBinding {
  return Object.fromEntries(
    evaluationEvidenceBindingKeys.map((key) => [key, result[key]]),
  ) as unknown as C.EvaluationEvidenceBinding;
}
export function resultEvidenceReferences(
  result: C.EvaluationCellResultV1,
): EvaluationEvidenceReference[] {
  const references = new Map<string, Set<string>>();
  for (const check of result.report.checks)
    for (const assetId of check.evidenceIds) {
      const checks = references.get(assetId) ?? new Set<string>();
      checks.add(check.id);
      references.set(assetId, checks);
    }
  return [...references].map(([assetId, checks]) => ({ assetId, checkIds: [...checks] }));
}
export function assertResultEvidenceReferences(
  list: C.EvaluationResultEvidenceListV1,
  binding: C.EvaluationEvidenceBinding,
  references: EvaluationEvidenceReference[],
): void {
  const expected = new Map(references.map((reference) => [reference.assetId, reference.checkIds]));
  if (
    !evaluationEvidenceBindingMatches(list.binding, binding) ||
    list.items.length !== expected.size ||
    new Set(list.items.map((row) => row.assetId)).size !== expected.size ||
    list.items.some((row) => {
      const checks = expected.get(row.assetId);
      return (
        !checks ||
        checks.length !== row.checkIds.length ||
        row.checkIds.some((id) => !checks.includes(id))
      );
    })
  )
    throw new ReviewControlProtocolError(
      "list evaluation evidence",
      "The evidence list does not contain exactly the selected result's recorded references.",
    );
}

export async function boundedEvidenceText(
  blob: Blob,
): Promise<{ text: string; truncated: boolean }> {
  const bytes = new Uint8Array(await blob.slice(0, maximumEvidenceTextPreviewBytes).arrayBuffer());
  const truncated = blob.size > bytes.byteLength;
  try {
    // Streaming defers only an incomplete final code point at the display boundary.
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated }),
      truncated,
    };
  } catch {
    throw new ReviewControlProtocolError(
      "preview evaluation evidence",
      "The verified file is not valid UTF-8 text in the displayed range.",
    );
  }
}
export const evidenceFileName = (manifest: C.EvidenceAssetManifest) =>
  `${manifest.id.replace(/[^A-Za-z0-9._-]/gu, "_")}.${({ "image/png": "png", "application/json": "json", "application/zip": "zip", "text/plain": "txt" } as const)[manifest.metadata.mediaType]}`;
export type EvidencePreview =
  | { kind: "image"; url: string; assetId: string }
  | { kind: "text"; text: string; truncated: boolean; assetId: string };
export interface EvidenceSessionState {
  busy: string | null;
  preview: EvidencePreview | null;
  error: { assetId: string; message: string; status?: number } | null;
  downloaded: string | null;
}
export interface EvidenceBrowserResources {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  download(url: string, fileName: string): void;
}
export const browserEvidenceResources: EvidenceBrowserResources = {
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  download: (url, fileName) => {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
  },
};

/** A result owns one verified preview or download at a time. Disposed owners cannot adopt late bytes. */
export class EvaluationEvidenceSession {
  #state: EvidenceSessionState = { busy: null, preview: null, error: null, downloaded: null };
  #listeners = new Set<() => void>();
  #controller: AbortController | null = null;
  #generation = 0;
  #disposed = false;
  #urls = new Set<string>();
  #timers = new Set<ReturnType<typeof setTimeout>>();
  constructor(
    private readonly adapter: EvaluationEvidenceAdapter,
    private readonly binding: C.EvaluationEvidenceBinding,
    private readonly resources: EvidenceBrowserResources,
    private readonly denied: () => void,
  ) {}
  readonly snapshot = () => this.#state;
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #set(next: EvidenceSessionState) {
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
  #revoke(url: string) {
    if (this.#urls.delete(url)) this.resources.revokeObjectURL(url);
  }
  reset() {
    this.#generation++;
    this.#controller?.abort();
    this.#controller = null;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    for (const url of [...this.#urls]) this.#revoke(url);
    this.#set({ busy: null, preview: null, error: null, downloaded: null });
  }
  activate() {
    this.#disposed = false;
  }
  dispose() {
    this.#disposed = true;
    this.reset();
    this.#listeners.clear();
  }
  closePreview() {
    if (this.#state.preview?.kind === "image") this.#revoke(this.#state.preview.url);
    this.#set({ ...this.#state, preview: null });
  }
  async run(action: "preview" | "download", manifest: C.EvidenceAssetManifest): Promise<void> {
    if (this.#disposed || this.#state.busy) return;
    this.reset();
    const generation = this.#generation,
      controller = new AbortController();
    this.#controller = controller;
    this.#set({ busy: manifest.id, preview: null, error: null, downloaded: null });
    const current = () =>
      !this.#disposed && generation === this.#generation && !controller.signal.aborted;
    try {
      const blob = await this.adapter.content(this.binding, manifest, controller.signal);
      if (!current()) return;
      if (blob.size !== manifest.metadata.sizeBytes || blob.type !== manifest.metadata.mediaType)
        throw new ReviewControlProtocolError(
          "preview evaluation evidence",
          "Verified content does not match the selected file metadata.",
        );
      if (action === "preview" && manifest.metadata.kind === "trace")
        throw new ReviewControlProtocolError(
          "preview evaluation evidence",
          "Trace files are available as downloads only.",
        );
      if (action === "preview" && blob.type !== "image/png") {
        const text = await boundedEvidenceText(blob);
        if (!current()) return;
        this.#set({
          busy: null,
          preview: { kind: "text", ...text, assetId: manifest.id },
          error: null,
          downloaded: null,
        });
      } else {
        const url = this.resources.createObjectURL(blob);
        this.#urls.add(url);
        if (action === "preview")
          this.#set({
            busy: null,
            preview: { kind: "image", url, assetId: manifest.id },
            error: null,
            downloaded: null,
          });
        else {
          this.resources.download(url, evidenceFileName(manifest));
          const timer = setTimeout(() => {
            this.#timers.delete(timer);
            this.#revoke(url);
          }, 1000);
          this.#timers.add(timer);
          this.#set({ busy: null, preview: null, error: null, downloaded: manifest.id });
        }
      }
    } catch (error) {
      if (!current()) return;
      for (const url of [...this.#urls]) this.#revoke(url);
      const status = error instanceof ReviewControlHttpError ? error.status : undefined;
      this.#set({
        busy: null,
        preview: null,
        downloaded: null,
        error: {
          assetId: manifest.id,
          message: errorMessage(error),
          ...(status === undefined ? {} : { status }),
        },
      });
      // A revoked repository is intentionally hidden behind 404. Recheck access rather than
      // assuming a selected file disappeared; a confirmed missing reference remains visible.
      if (status === 401 || status === 403 || status === 404) this.denied();
    } finally {
      if (generation === this.#generation) this.#controller = null;
    }
  }
}
