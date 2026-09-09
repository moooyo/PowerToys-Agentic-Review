import type { OperatorPrincipal } from "@agentic-review/contracts";
import type { DatabaseClient } from "./database-client.js";
import { OperatorAccessError } from "./operator-access.js";
import {
  cloneOperatorInput,
  createOperatorRequestContext,
  isOperatorRequestOperation,
  type OperatorRequestInput,
} from "./operator-request.js";
import type { DatabaseOperation, DatabaseOperationMap } from "./protocol.js";

export interface OperatorDatabaseTransport {
  request(operation: "operatorRequest", input: OperatorRequestInput): Promise<unknown>;
}

/** A bound route dependency can send only explicitly allowed operations through operatorRequest. */
export function bindOperatorDatabase(
  database: OperatorDatabaseTransport,
  actor: OperatorPrincipal,
): Pick<DatabaseClient, "request"> {
  const context = createOperatorRequestContext(actor);
  return Object.freeze({
    async request<K extends Exclude<DatabaseOperation, "shutdown">>(
      operation: K,
      input: DatabaseOperationMap[K]["input"],
    ): Promise<DatabaseOperationMap[K]["output"]> {
      if (!isOperatorRequestOperation(operation))
        throw new OperatorAccessError(
          "PLATFORM_FORBIDDEN",
          "This database operation is not available to operators.",
        );
      return (await database.request("operatorRequest", {
        context,
        operation,
        input: cloneOperatorInput(input),
      })) as DatabaseOperationMap[K]["output"];
    },
  });
}
