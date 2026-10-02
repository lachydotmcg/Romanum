import { createRequire } from "node:module";
import type { JsonObject } from "../protocol.ts";

export interface ProtocolSchema { safeParse(value: unknown): { success: boolean } }
export interface SdkValidator {
  ajv: { validateSchema(schema: JsonObject): boolean };
  getValidator(schema: JsonObject): (input: unknown) => { valid: boolean };
}
export interface McpSdk {
  schemas: Record<string, ProtocolSchema>;
  createValidator(): SdkValidator;
  environment(): Record<string, string>;
}

/** Load already installed, lockfile-managed SDK dependencies. The optional
 * resolution anchor is trusted local toolchain configuration, never model input.
 * No download, install, dynamic URL import or executable path is inferred.
 */
export function loadInstalledMcpSdk(resolutionAnchor: string | URL = import.meta.url): McpSdk {
  const require = createRequire(resolutionAnchor);
  const clientRequire = createRequire(require.resolve("@modelcontextprotocol/client"));
  const schemas = clientRequire("@modelcontextprotocol/core") as McpSdk["schemas"];
  const provider = require("@modelcontextprotocol/client/validators/ajv") as { AjvJsonSchemaValidator: new () => SdkValidator };
  const stdio = require("@modelcontextprotocol/client/stdio") as { getDefaultEnvironment(): Record<string, string> };
  return { schemas, createValidator: () => new provider.AjvJsonSchemaValidator(), environment: () => stdio.getDefaultEnvironment() };
}
