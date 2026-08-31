import type {
  BeginOperatorLoginInput,
  BeginOperatorLoginResult,
  ClaimOperatorLoginTransactionInput,
  CreateOperatorSessionInput,
  DeleteOperatorBrowserFlowInput,
  DeleteOperatorSessionInput,
  FinalizeOperatorLoginInput,
  FindOperatorSessionInput,
  OperatorAuthPersistence,
  OperatorSession,
} from "../security/operator-auth.js";
import type { DatabaseClient } from "./database-client.js";

export class DatabaseOperatorAuthPersistence implements OperatorAuthPersistence {
  readonly #database: Pick<DatabaseClient, "request">;

  public constructor(database: Pick<DatabaseClient, "request">) {
    this.#database = database;
  }

  public async beginLogin(input: BeginOperatorLoginInput): Promise<BeginOperatorLoginResult> {
    return this.#database.request("beginOperatorLogin", input);
  }

  public async claimLoginTransaction(
    input: ClaimOperatorLoginTransactionInput,
  ): Promise<number | null> {
    const result = await this.#database.request("claimOperatorLoginTransaction", input);
    return result.browserGeneration;
  }

  public async finalizeLogin(input: FinalizeOperatorLoginInput): Promise<boolean> {
    const result = await this.#database.request("finalizeOperatorLogin", input);
    return result.finalized;
  }

  public async createSession(input: CreateOperatorSessionInput): Promise<void> {
    await this.#database.request("createOperatorSession", input);
  }

  public async findSession(input: FindOperatorSessionInput): Promise<OperatorSession | null> {
    const result = await this.#database.request("findOperatorSession", input);
    return result.session;
  }

  public async deleteSession(input: DeleteOperatorSessionInput): Promise<void> {
    await this.#database.request("deleteOperatorSession", input);
  }

  public async deleteBrowserFlow(input: DeleteOperatorBrowserFlowInput): Promise<void> {
    await this.#database.request("deleteOperatorBrowserFlow", input);
  }
}
