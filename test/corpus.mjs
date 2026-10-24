// Schemas as real tools produce them: Zod v4, Pydantic, MCP servers, OpenAPI, older drafts.
import { z } from "zod";

const zod = (s) => z.toJSONSchema(s, { target: "draft-2020-12" });

const Category = z.object({
  name: z.string(),
  get children() {
    return z.array(Category);
  },
});

export const CORPUS = {
  "zod: weather tool with optional enum": zod(z.object({ city: z.string(), units: z.enum(["c", "f"]).optional() })),
  "zod: optional, nullable, default": zod(
    z.object({ name: z.string(), nick: z.string().nullable(), age: z.number().int().optional(), tags: z.array(z.string()).default([]) }),
  ),
  "zod: record (map)": zod(z.object({ scores: z.record(z.string(), z.number()) })),
  "zod: record of objects": zod(z.object({ users: z.record(z.string(), z.object({ id: z.number(), admin: z.boolean().optional() })) })),
  "zod: tuple": zod(z.object({ point: z.tuple([z.number(), z.number()]), label: z.tuple([z.string(), z.boolean()]).optional() })),
  "zod: discriminated union at the root": zod(
    z.discriminatedUnion("kind", [z.object({ kind: z.literal("circle"), r: z.number() }), z.object({ kind: z.literal("rect"), w: z.number(), h: z.number() })]),
  ),
  "zod: recursive tree": zod(z.object({ root: Category })),
  "zod: number literals and mixed enum": zod(z.object({ level: z.union([z.literal(1), z.literal(2), z.literal(3)]), flag: z.union([z.literal("on"), z.literal(0)]) })),
  "zod: string constraints and formats": zod(
    z.object({
      handle: z.string().min(3).max(20).regex(/^[a-z]+$/),
      email: z.email(),
      site: z.url(),
      id: z.uuid(),
      when: z.iso.datetime(),
      count: z.number().int().min(0).max(100).multipleOf(5),
    }),
  ),
  "zod: any and unknown": zod(z.object({ payload: z.any(), meta: z.unknown().optional(), extra: z.looseObject({ a: z.string() }).optional() })),
  "zod: nested arrays of optional objects": zod(
    z.object({ rows: z.array(z.object({ cells: z.array(z.union([z.string(), z.number(), z.null()])), note: z.string().optional() })).min(2).max(5) }),
  ),
  "pydantic: $defs, Optional, defaults, titles": {
    $defs: {
      Address: { properties: { street: { title: "Street", type: "string" }, zip: { anyOf: [{ type: "string" }, { type: "null" }], default: null, title: "Zip" } }, required: ["street"], title: "Address", type: "object" },
    },
    properties: {
      name: { title: "Name", type: "string" },
      home: { $ref: "#/$defs/Address" },
      work: { anyOf: [{ $ref: "#/$defs/Address" }, { type: "null" }], default: null },
      past: { items: { $ref: "#/$defs/Address" }, title: "Past", type: "array" },
    },
    required: ["name", "home"],
    title: "Person",
    type: "object",
  },
  "mcp: github-style tool": {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner" },
      repo: { type: "string" },
      state: { type: "string", enum: ["open", "closed", "all"] },
      labels: { type: "array", items: { type: "string" } },
      perPage: { type: "number", minimum: 1, maximum: 100 },
      since: { type: "string", format: "date-time" },
    },
    required: ["owner", "repo"],
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#",
  },
  "mcp: tool with no arguments": { type: "object", properties: {} },
  "mcp: free-form options object": { type: "object", properties: { query: { type: "string" }, options: { type: "object", additionalProperties: true } }, required: ["query"] },
  "openapi 3.0: nullable": { type: "object", properties: { name: { type: "string", nullable: true }, size: { type: "integer", nullable: true, minimum: 1 } }, required: ["name"] },
  "draft-07: definitions, array-form items": {
    definitions: { Pt: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } },
    type: "object",
    properties: { a: { $ref: "#/definitions/Pt" }, pair: { type: "array", items: [{ type: "string" }, { type: "integer" }] } },
    required: ["a", "pair"],
  },
  "draft-04: boolean exclusiveMinimum": { type: "object", properties: { n: { type: "number", minimum: 0, exclusiveMinimum: true } }, required: ["n"] },
  "allOf: base plus extension": {
    definitions: { Base: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    allOf: [{ $ref: "#/definitions/Base" }, { type: "object", properties: { extra: { type: "boolean" } } }],
  },
  "root array": { type: "array", items: { type: "object", properties: { t: { type: "string" } }, required: ["t"] } },
  "root enum": { type: "string", enum: ["yes", "no"] },
  "const and multi-type": { type: "object", properties: { v: { const: 2 }, x: { type: ["string", "number"] }, s: { const: "fixed" } }, required: ["v", "x", "s"] },
  "oneOf and not": {
    type: "object",
    properties: { pay: { oneOf: [{ type: "object", properties: { card: { type: "string" } }, required: ["card"] }, { type: "object", properties: { iban: { type: "string" } }, required: ["iban"] }] }, n: { type: "integer", not: { const: 0 } } },
    required: ["pay", "n"],
  },
  "ref with description sibling": { type: "object", $defs: { Id: { type: "string", format: "uuid" } }, properties: { id: { $ref: "#/$defs/Id", description: "the id" } }, required: ["id"] },
};
