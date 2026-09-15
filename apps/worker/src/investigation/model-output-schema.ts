import type { TSchema } from "@sinclair/typebox";

type SchemaObject = Record<string, unknown>;

/**
 * Keep the model-facing schema within the strict structured-output subset.
 * Full TypeBox and semantic validation remains authoritative after generation.
 * https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas
 */
export function createInvestigationModelOutputSchema(schema: TSchema): SchemaObject {
  const project = (value: unknown, path: string): SchemaObject => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new TypeError(`The model schema at ${path} must be an object.`);
    const source = value as SchemaObject;
    const result: SchemaObject = {};
    for (const key of [
      "type",
      "description",
      "title",
      "enum",
      "const",
      "$ref",
      "pattern",
      "format",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
      "minItems",
      "maxItems",
    ] as const) {
      if (source[key] !== undefined) result[key] = structuredClone(source[key]);
    }
    if (source.anyOf !== undefined) {
      if (!Array.isArray(source.anyOf)) throw new TypeError(`Invalid model union at ${path}.`);
      result.anyOf = source.anyOf.map((branch, index) =>
        project(branch, `${path}.anyOf[${index}]`),
      );
    }
    if (source.items !== undefined) result.items = project(source.items, `${path}.items`);
    if (source.$defs !== undefined) {
      const definitions = source.$defs as Record<string, unknown>;
      result.$defs = Object.fromEntries(
        Object.entries(definitions).map(([name, definition]) => [
          name,
          project(definition, `${path}.$defs.${name}`),
        ]),
      );
    }
    if (source.type === "object") {
      if (
        source.additionalProperties !== false ||
        source.properties === null ||
        typeof source.properties !== "object" ||
        Array.isArray(source.properties)
      )
        throw new TypeError(
          `Model objects require explicit properties and additionalProperties=false at ${path}.`,
        );
      const properties = source.properties as Record<string, unknown>;
      const names = Object.keys(properties);
      const required = new Set(Array.isArray(source.required) ? source.required : []);
      if (names.some((name) => !required.has(name)) || required.size !== names.length)
        throw new TypeError(
          `Model properties must be required; represent absence with an explicit nullable union at ${path}.`,
        );
      result.properties = Object.fromEntries(
        names.map((name) => [name, project(properties[name], `${path}.properties.${name}`)]),
      );
      result.required = names;
      result.additionalProperties = false;
    }
    for (const unsupported of [
      "allOf",
      "oneOf",
      "not",
      "if",
      "then",
      "else",
      "dependentRequired",
      "dependentSchemas",
      "patternProperties",
    ])
      if (source[unsupported] !== undefined)
        throw new TypeError(`Unsupported model schema composition ${unsupported} at ${path}.`);
    if (result.type === undefined && result.anyOf === undefined && result.$ref === undefined)
      throw new TypeError(`The model schema at ${path} has no supported type.`);
    return result;
  };
  const result = project(schema, "$schema");
  if (result.type !== "object" || result.anyOf !== undefined)
    throw new TypeError("The model output schema must have a strict object root.");
  return result;
}
