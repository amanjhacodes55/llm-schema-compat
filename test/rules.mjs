// Each provider's documented schema rules, as checkers. They return a list of violations.
// OpenAI: Structured Outputs "Supported schemas". Anthropic: Structured outputs, "JSON Schema
// limitations". Gemini: API reference, `Schema` object (an OpenAPI 3.0 subset).

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function walk(s, path, visit, depth = 0) {
  if (!isObj(s)) return;
  visit(s, path, depth);
  for (const [k, v] of Object.entries(s.properties ?? {})) walk(v, `${path}/properties/${k}`, visit, depth + 1);
  if (isObj(s.items)) walk(s.items, `${path}/items`, visit, depth + 1);
  for (const key of ["anyOf", "allOf"]) (s[key] ?? []).forEach((b, i) => walk(b, `${path}/${key}/${i}`, visit, depth));
  for (const [k, v] of Object.entries(s.$defs ?? {})) walk(v, `#/$defs/${k}`, visit, 0);
}

const OPENAI_KEYS = new Set(["type", "properties", "required", "additionalProperties", "items", "anyOf", "enum", "const", "description", "title", "$defs", "$ref", "pattern", "format", "multipleOf", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minItems", "maxItems"]);
const OPENAI_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "ipv4", "ipv6", "uuid"]);
const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

export function openai(schema) {
  const errors = [];
  if (schema.type !== "object") errors.push("#: root must be an object");
  if (schema.anyOf) errors.push("#: root can't be anyOf");
  let props = 0;
  let enums = 0;
  walk(schema, "#", (s, path, depth) => {
    if (depth > 10) errors.push(`${path}: nested deeper than 10 levels`);
    for (const k of Object.keys(s)) if (!OPENAI_KEYS.has(k)) errors.push(`${path}: unsupported keyword ${k}`);
    if (s.$defs && path !== "#") errors.push(`${path}: $defs only at the root`);
    if (s.$ref !== undefined) {
      if (Object.keys(s).length > 1) errors.push(`${path}: $ref with sibling keywords`);
      if (s.$ref !== "#" && !(s.$ref.startsWith("#/$defs/") && schema.$defs?.[s.$ref.slice(8)])) errors.push(`${path}: dangling $ref ${s.$ref}`);
    }
    const types = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
    for (const t of types) if (!TYPES.has(t)) errors.push(`${path}: bad type ${t}`);
    if (s.type === undefined && !s.anyOf && !s.$ref && !s.enum && !("const" in s)) errors.push(`${path}: no type`);
    if (types.includes("object")) {
      if (s.additionalProperties !== false) errors.push(`${path}: additionalProperties must be false`);
      const keys = Object.keys(s.properties ?? {});
      props += keys.length;
      const req = new Set(s.required ?? []);
      if (keys.some((k) => !req.has(k)) || req.size !== keys.length) errors.push(`${path}: every property must be required`);
    }
    if (types.includes("array") && !isObj(s.items)) errors.push(`${path}: array without items`);
    if (s.format && !OPENAI_FORMATS.has(s.format)) errors.push(`${path}: unsupported format ${s.format}`);
    if (Array.isArray(s.enum)) enums += s.enum.length;
  });
  if (props > 5000) errors.push("more than 5000 properties");
  if (enums > 1000) errors.push("more than 1000 enum values");
  return errors;
}

const ANTHROPIC_KEYS = new Set(["type", "properties", "required", "additionalProperties", "items", "anyOf", "allOf", "enum", "const", "description", "title", "default", "$ref", "$defs", "definitions", "format", "pattern", "minItems"]);
const ANTHROPIC_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);

export function anthropic(schema) {
  const errors = [];
  if (schema.type !== "object") errors.push("#: tool input must be an object");
  let optional = 0;
  let unions = 0;
  walk(schema, "#", (s, path) => {
    for (const k of Object.keys(s)) if (!ANTHROPIC_KEYS.has(k)) errors.push(`${path}: unsupported keyword ${k}`);
    if (s.$ref !== undefined) errors.push(`${path}: $ref left in (recursion is not supported; we inline everything)`);
    const types = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
    for (const t of types) if (!TYPES.has(t)) errors.push(`${path}: bad type ${t}`);
    if (types.includes("object")) {
      if (s.additionalProperties !== false) errors.push(`${path}: additionalProperties must be false`);
      const req = new Set(s.required ?? []);
      optional += Object.keys(s.properties ?? {}).filter((k) => !req.has(k)).length;
    }
    if (s.anyOf || types.length > 1) unions++;
    if (Array.isArray(s.enum) && s.enum.some((v) => typeof v === "object" && v !== null)) errors.push(`${path}: complex enum value`);
    if (s.format && !ANTHROPIC_FORMATS.has(s.format)) errors.push(`${path}: unsupported format ${s.format}`);
    if (s.minItems !== undefined && s.minItems !== 0 && s.minItems !== 1) errors.push(`${path}: minItems other than 0 or 1`);
    if (s.pattern && /\(\?[=!<]|\\[1-9bB]/.test(s.pattern)) errors.push(`${path}: unsupported regex feature`);
  });
  if (optional > 24) errors.push(`${optional} optional parameters (limit 24)`);
  if (unions > 16) errors.push(`${unions} union parameters (limit 16)`);
  return errors;
}

const GEMINI_KEYS = new Set(["type", "format", "title", "description", "nullable", "enum", "maxItems", "minItems", "properties", "required", "minProperties", "maxProperties", "minLength", "maxLength", "pattern", "example", "anyOf", "propertyOrdering", "default", "items", "minimum", "maximum"]);
const GEMINI_TYPES = new Set(["STRING", "NUMBER", "INTEGER", "BOOLEAN", "ARRAY", "OBJECT", "NULL"]);

export function gemini(schema) {
  const errors = [];
  if (schema.type !== "OBJECT") errors.push("#: function parameters must be an OBJECT");
  walk(schema, "#", (s, path) => {
    for (const k of Object.keys(s)) if (!GEMINI_KEYS.has(k)) errors.push(`${path}: unknown field ${k}`);
    if (s.type === undefined && !s.anyOf) errors.push(`${path}: type is required`);
    if (s.type !== undefined && !GEMINI_TYPES.has(s.type)) errors.push(`${path}: bad type ${JSON.stringify(s.type)}`);
    if (s.enum && (s.type !== "STRING" || s.enum.some((v) => typeof v !== "string"))) errors.push(`${path}: enum only on STRING`);
    if (s.type === "OBJECT") {
      const keys = Object.keys(s.properties ?? {});
      if (!keys.length && path !== "#") errors.push(`${path}: properties should be non-empty for OBJECT type`);
      for (const r of s.required ?? []) if (!keys.includes(r)) errors.push(`${path}: required ${r} not in properties`);
      if (s.propertyOrdering && JSON.stringify([...s.propertyOrdering].sort()) !== JSON.stringify([...keys].sort())) errors.push(`${path}: propertyOrdering mismatch`);
    }
    if (s.type === "ARRAY" && !isObj(s.items)) errors.push(`${path}: ARRAY without items`);
  });
  return errors;
}

/** Gemini's dialect back to standard JSON Schema, so Ajv can check values against it. */
export function geminiToJsonSchema(s) {
  if (!isObj(s)) return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "propertyOrdering" || k === "nullable" || k === "example") continue;
    if (k === "type") out.type = v.toLowerCase();
    else if (k === "properties") out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, geminiToJsonSchema(pv)]));
    else if (k === "items") out.items = geminiToJsonSchema(v);
    else if (k === "anyOf") out.anyOf = v.map(geminiToJsonSchema);
    else out[k] = v;
  }
  if (s.nullable) {
    if (out.anyOf) out.anyOf.push({ type: "null" });
    else {
      out.type = [out.type, "null"];
      if (out.enum) out.enum = [...out.enum, null];
    }
  }
  return out;
}
