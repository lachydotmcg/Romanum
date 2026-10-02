import { createHash } from "node:crypto";
import type { JsonObject } from "../protocol.ts";
import type { McpSdk } from "./sdk.ts";

// Deliberately bounded schema subset: no refs, regex, recursive/conditional or
// combinatorial schemas. Unsupported constraints fail closed, never disappear.
const KEYS = new Set(["$schema", "type", "properties", "required", "additionalProperties", "items", "enum", "const", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "description", "title", "default"]);
const DIALECTS = new Set(["https://json-schema.org/draft/2020-12/schema", "https://json-schema.org/draft/2020-12/schema#"]);
export class InputSchemaError extends Error {
  constructor() { super("Studio transport: invalid_schema."); this.name = "InputSchemaError"; }
}

export function createSdkInputValidator(sdk: McpSdk): {
  inspect(schema: unknown): void;
  validateInput(schema: JsonObject, input: JsonObject): boolean;
} {
  const provider = sdk.createValidator();
  const compiled = new Map<string, (input: unknown) => { valid: boolean }>();
  function compile(schema: unknown): (input: unknown) => { valid: boolean } {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new InputSchemaError();
    const text = JSON.stringify(schema);
    if (Buffer.byteLength(text) > 32 * 1024) throw new InputSchemaError();
    const key = createHash("sha256").update(text).digest("hex");
    const cached = compiled.get(key);
    if (cached) return cached;
    if (compiled.size >= 64) throw new InputSchemaError();
    let nodes = 0;
    function visit(value: unknown, depth: number): void {
      if (++nodes > 128 || depth > 12 || !value || typeof value !== "object" || Array.isArray(value)) throw new InputSchemaError();
      const node = value as Record<string, unknown>;
      if (Object.keys(node).some((name) => !KEYS.has(name))) throw new InputSchemaError();
      if (node.$schema !== undefined && !DIALECTS.has(node.$schema as string)) throw new InputSchemaError();
      if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length > 100)) throw new InputSchemaError();
      if (node.properties !== undefined) {
        if (!node.properties || typeof node.properties !== "object" || Array.isArray(node.properties)) throw new InputSchemaError();
        for (const child of Object.values(node.properties)) visit(child, depth + 1);
      }
      if (node.items !== undefined) visit(node.items, depth + 1);
      if (typeof node.additionalProperties === "object") visit(node.additionalProperties, depth + 1);
    }
    visit(schema, 0);
    const copy = JSON.parse(text) as JsonObject;
    if (copy.type !== "object" || !provider.ajv.validateSchema(copy)) throw new InputSchemaError();
    let validate: (input: unknown) => { valid: boolean };
    try { validate = provider.getValidator(copy); } catch { throw new InputSchemaError(); }
    compiled.set(key, validate);
    return validate;
  }
  return {
    inspect(schema) { compile(schema); },
    validateInput(schema, input) {
      try {
        if (Buffer.byteLength(JSON.stringify(input)) > 64 * 1024) return false;
        return compile(schema)(input).valid;
      } catch { return false; }
    },
  };
}
