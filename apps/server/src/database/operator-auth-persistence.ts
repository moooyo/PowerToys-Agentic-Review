import type {
  ConsumeOperatorLoginTransactionInput,
  CreateOperatorLoginTransactionInput,
  CreateOperatorSessionInput,
  DeleteOperatorSessionInput,
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

  public async createLoginTransaction(input: CreateOperatorLoginTransactionInput): Promise<void> {
    await this.#database.request("createOperatorLoginTransaction", input);
  }

  public async consumeLoginTransaction(
    input: ConsumeOperatorLoginTransactionInput,
  ): Promise<boolean> {
    const result = await this.#database.request("consumeOperatorLoginTransaction", input);
    return result.consumed;
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
}
