# llm-schema-compat

**One JSON Schema that works with OpenAI, Claude and Gemini**, plus a decoder that turns the model's
answer back into the shape your code expects. It has no dependencies.

```js
import { adapt } from "llm-schema-compat";

const tool = adapt(mySchema, "openai"); // or "anthropic", "gemini"

// send tool.schema to the model, then:
const args = tool.decode(JSON.parse(toolCall.function.arguments)); // back in your original shape
```

## The problem

Each provider accepts a different, stricter subset of JSON Schema, and each rejects schemas
differently:

- **OpenAI strict mode** needs `additionalProperties: false` on every object and every field in
  `required`. It rejects `oneOf`, `allOf` and a union at the root.
- **Claude** (strict tools, structured outputs) rejects recursion, `minLength`, `minimum`,
  `maxItems` and maps. It allows at most 24 optional parameters.
- **Gemini** takes an OpenAPI dialect. It has no `$ref`, `const`, `oneOf` or `additionalProperties`,
  only string enums, and upper-case types.

So a schema from Zod, Pydantic, TypeBox or an MCP server fails with `Invalid schema for function`,
`400 INVALID_ARGUMENT` or `Unknown name "additionalProperties"`. The usual fix is hand-editing the
schema per provider, which then changes the shape of the data your code receives.

**All 37 tool schemas from the official MCP servers** (everything, filesystem, memory,
sequential-thinking) break the documented strict-mode rules of all three providers. After `adapt`,
all 37 pass for all three.

## What it does

`adapt(schema, target)` rewrites the schema for the target and records every change it made, so
`decode()` can undo it:

| Your schema has | Becomes | `decode()` gives you back |
| --- | --- | --- |
| optional field (OpenAI) | required, may be `null` | the field missing again |
| map, `{ [key]: T }` (`z.record`, `Dict[str, T]`) | list of `{ key, value }` | the object |
| tuple, `[string, number]` | object with keys `"0"`, `"1"` | the array |
| free-form value (`{}`, `any`, `additionalProperties: true`) | JSON string | the parsed value |
| number or boolean enum (Gemini) | string enum | the original values |
| non-object root (array, union, enum) | `{ value: ... }` | the unwrapped value |
| recursion (Claude, Gemini) | unrolled 3 levels, then a JSON string | the full tree |
| `oneOf` | `anyOf` | (same value) |
| `allOf` | merged into one object | (same value) |
| `$ref` | `$defs` (OpenAI) or inlined | (same value) |
| `const`, `type: [...]`, OpenAPI `nullable` | each provider's way of saying it | (same value) |
| constraints the provider rejects (`minLength`, `pattern`, `format`, ...) | a hint in the `description` | (same value) |

Everything that couldn't be expressed exactly is listed in `warnings`, each with a JSON pointer to
where it happened. That includes constraints the model is now only asked to follow, dropped
keywords and size limits that would be exceeded. Validate the decoded output with your original
validator (Zod, Ajv) if those constraints matter.

The input can be draft-04, draft-07, 2020-12 or OpenAPI 3.0: `definitions`, array-form `items`,
boolean `exclusiveMinimum` and `nullable` are all understood. The input schema is never modified.

## Usage

### OpenAI

```js
const tool = adapt(schema, "openai");

const res = await openai.chat.completions.create({
  model,
  messages,
  tools: [{ type: "function", function: { name: "search", parameters: tool.schema, strict: true } }],
});
const args = tool.decode(JSON.parse(res.choices[0].message.tool_calls[0].function.arguments));
```

For structured output, pass `response_format: { type: "json_schema", json_schema: { name: "result", schema: tool.schema, strict: true } }`
and decode the parsed message content.

### Claude

```js
const tool = adapt(schema, "anthropic");

const res = await anthropic.messages.create({
  model,
  max_tokens: 1024,
  messages,
  tools: [{ name: "search", description: "...", input_schema: tool.schema, strict: true }],
});
const args = tool.decode(res.content.find((b) => b.type === "tool_use").input);
```

### Gemini

```js
const tool = adapt(schema, "gemini");

const res = await ai.models.generateContent({
  model,
  contents,
  config: { tools: [{ functionDeclarations: [{ name: "search", description: "...", parameters: tool.schema }] }] },
});
const args = tool.decode(res.functionCalls[0].args);
```

Use it as `responseSchema` (with `responseMimeType: "application/json"`) for structured output.

### Zod, Pydantic, MCP

Anything that produces JSON Schema works:

```js
adapt(z.toJSONSchema(MyZodSchema), "gemini"); // Zod 4
adapt(pydanticModelJsonSchemaFromYourApi, "openai");
for (const t of (await mcpClient.listTools()).tools) adapt(t.inputSchema, "anthropic");
```

### Few-shot examples and tests

`encode(value)` is the reverse of `decode`. It turns a value of your original shape into what the
model should produce, which is useful for examples in prompts and for tests.

## How it is tested

- **Documented rules.** Each provider's rules from its docs are written as checkers, and every
  adapted schema is checked against them.
- **Round trips.** Random values valid for the original schema are encoded, validated against the
  adapted schema with Ajv, decoded, and compared with the original value.
- **Fuzzing.** A fuzzer builds random schemas from every feature listed above (nesting, unions,
  maps, tuples, refs, recursion, enums, nullability). Before release it ran 35,000 of them through
  all three targets.
- **Real-world schemas.** The test corpus includes schemas from Zod 4, Pydantic, MCP servers,
  OpenAPI and older drafts, and the 37 real MCP tool schemas.

The rules come from each provider's documentation (OpenAI "Supported schemas", Anthropic "JSON
Schema limitations", Gemini's `Schema` reference) as of October 2026. They are not checked against
the live APIs in CI. If a provider rejects an adapted schema, please open an issue with the error.

## Limits

- **Objects are closed.** Keys not listed in `properties` are dropped, because every strict mode
  requires `additionalProperties: false`. Use a map type if you need open keys.
- **OpenAI: optional and nullable can't be told apart.** If a field is both optional and nullable,
  a returned `null` stays `null`, because OpenAI makes every field present. Fields that are only
  optional get their `null` removed.
- **Constraints moved to descriptions are requests, not guarantees.** Validate after decoding.
- **Only local `$ref`s are followed** (`#/...`). Remote refs are treated as any value, with a
  warning.

## License

MIT
