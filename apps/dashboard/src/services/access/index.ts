import { repositories } from "../repositories";
import { ReviewControlHttpError } from "../review-control/errors";
import type { AccessAdapter } from "./adapter";
import { HttpAccessAdapter } from "./http-adapter";
import { MockAccessAdapter } from "./mock-adapter";

export const access: AccessAdapter =
  process.env.NODE_ENV === "development"
    ? new MockAccessAdapter({
        repositoryExists: async (repositoryId) => {
          try {
            return (await repositories.get(repositoryId)).id === repositoryId;
          } catch (error) {
            if (error instanceof ReviewControlHttpError && error.status === 404) return false;
            throw error;
          }
        },
      })
    : new HttpAccessAdapter();

export type { AccessAdapter, AccessPageQuery } from "./adapter";
export { HttpAccessAdapter } from "./http-adapter";
export {
  MockAccessAdapter,
  type MockAccessAdapterOptions,
  sampleOperatorPrincipal,
} from "./mock-adapter";
