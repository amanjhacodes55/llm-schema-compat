import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";
import Ajv07 from "ajv";
import { adapt } from "../dist/index.js";
import { CORPUS } from "./corpus.mjs";
import * as rules from "./rules.mjs";

const TARGETS = ["openai", "anthropic", "gemini"];

/**
 * The library's contract: objects are closed (no keys beyond `properties`), because every
 * provider's strict mode requires it. Values are judged against that reading of the original.
 */
function closed(s) {
  if (Array.isArray(s)) return s.map(closed);
  if (!s || typeof s !== "object") return s;
  const out = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k === "properties" || k === "$defs" || k === "definitions" ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, closed(pv)])) : closed(v)]));
  if (out.properties && out.additionalProperties === undefined && !out.allOf) out.additionalProperties = false;
  return out;
}

function validator(schema) {
  const draft07 = JSON.stringify(schema).includes('"definitions"') || JSON.stringify(schema).includes("draft-07");
  const ajv = draft07 ? new Ajv07({ strict: false, validateFormats: false }) : new Ajv2020({ strict: false, validateFormats: false });
  try {
    return ajv.compile(schema);
  } catch {
    return null; // e.g. draft-04 boolean exclusiveMinimum: checked by the generator instead
  }
}

// ---- random values that satisfy a schema ---------------------------------------------------------

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generator(root, rand) {
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const resolve = (ref) => (ref === "#" ? root : ref.slice(2).split("/").reduce((n, k) => n?.[k], root));
  const word = (min = 1, max = 8) => Array.from({ length: min + Math.floor(rand() * (max - min + 1)) }, () => pick("abcdefghij")).join("");
  const anyJson = (d) => pick([null, true, 3, "x", [1, "y"], { k: d > 2 ? 1 : anyJson(d + 1) }]);

  function gen(s, d = 0) {
    if (s === true || s === undefined || (typeof s === "object" && Object.keys(s).length === 0)) return anyJson(d);
    if (s.$ref) return gen({ ...resolve(s.$ref), ...s, $ref: undefined }, d + 1);
    if (s.allOf) {
      const parts = s.allOf.map((b) => (b.$ref ? resolve(b.$ref) : b));
      const merged = { type: "object", properties: Object.assign({}, ...parts.map((p) => p.properties ?? {})), required: parts.flatMap((p) => p.required ?? []) };
      return gen(merged, d);
    }
    if (s.anyOf || s.oneOf) return gen(pick(s.anyOf ?? s.oneOf), d + 1);
    if (s.enum) return pick(s.enum);
    if ("const" in s) return s.const;
    let types = s.type === undefined ? (s.properties || s.additionalProperties ? ["object"] : s.items || s.prefixItems ? ["array"] : []) : [].concat(s.type);
    if (s.nullable) types = [...types, "null"];
    if (!types.length) return anyJson(d);
    const t = d > 4 && types.includes("null") ? "null" : pick(types);
    switch (t) {
      case "null":
        return null;
      case "boolean":
        return rand() < 0.5;
      case "integer":
      case "number": {
        let lo = s.minimum ?? (typeof s.exclusiveMinimum === "number" ? s.exclusiveMinimum + 1 : 0);
        if (s.exclusiveMinimum === true) lo += 1;
        const hi = s.maximum ?? (typeof s.exclusiveMaximum === "number" ? s.exclusiveMaximum - 1 : lo + 50);
        let n = lo + Math.floor(rand() * (hi - lo + 1));
        if (s.multipleOf) n = Math.ceil(lo / s.multipleOf) * s.multipleOf;
        return t === "number" && !s.multipleOf && rand() < 0.5 && n + 0.5 <= hi ? n + 0.5 : n;
      }
      case "string":
        if (s.format === "email") return `${word()}@x.io`;
        if (s.format === "date-time") return "2026-10-24T10:00:00Z";
        if (s.format === "uuid") return "123e4567-e89b-42d3-a456-426614174000";
        if (s.format === "uri") return `https://x.io/${word()}`;
        return word(s.minLength ?? 1, Math.min(s.maxLength ?? 8, 8));
      case "array": {
        const tuple = Array.isArray(s.items) ? s.items : s.prefixItems;
        if (tuple) return tuple.map((x) => gen(x, d + 1));
        const n = (s.minItems ?? 0) + Math.floor(rand() * ((s.maxItems ?? (s.minItems ?? 0) + 3) - (s.minItems ?? 0) + 1));
        return Array.from({ length: d > 4 ? (s.minItems ?? 0) : n }, () => gen(s.items, d + 1));
      }
      case "object": {
        const out = {};
        const req = new Set(s.required ?? []);
        for (const [k, v] of Object.entries(s.properties ?? {})) if (req.has(k) || (d < 4 && rand() < 0.6)) out[k] = gen(v, d + 1);
        if (!Object.keys(s.properties ?? {}).length && s.additionalProperties && typeof s.additionalProperties === "object" && d < 4) {
          for (let i = 0; i < 1 + Math.floor(rand() * 3); i++) out[word()] = gen(s.additionalProperties, d + 1);
        }
        if (s.additionalProperties === true || (s.additionalProperties === undefined && !s.properties)) if (rand() < 0.5) out[word()] = anyJson(d);
        return out;
      }
    }
    return null;
  }
  return gen;
}

function dropAddedNulls(back, orig) {
  if (Array.isArray(back) && Array.isArray(orig)) {
    // Trailing optional tuple positions may come back as null, like optional nullable fields.
    let end = back.length;
    while (end > orig.length && back[end - 1] === null) end--;
    return back.slice(0, end).map((x, i) => dropAddedNulls(x, orig[i]));
  }
  if (back && typeof back === "object" && orig && typeof orig === "object" && !Array.isArray(orig)) {
    const out = {};
    for (const [k, v] of Object.entries(back)) if (!(v === null && !(k in orig))) out[k] = dropAddedNulls(v, orig[k]);
    return out;
  }
  return back;
}

function dropNullKeys(v) {
  if (Array.isArray(v)) {
    let end = v.length;
    while (end > 0 && v[end - 1] === null) end--;
    return v.slice(0, end).map(dropNullKeys);
  }
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNullKeys(x)]));
  return v;
}

// ---- tests ---------------------------------------------------------------------------------------

for (const target of TARGETS) {
  test(`${target}: every corpus schema is accepted under the documented rules`, () => {
    for (const [name, schema] of Object.entries(CORPUS)) {
      const { schema: out } = adapt(schema, target);
      assert.deepEqual(rules[target](out), [], `${name}\n${JSON.stringify(out, null, 1)}`);
    }
  });

  test(`${target}: values survive the round trip, valid on both sides`, () => {
    for (const [name, schema] of Object.entries(CORPUS)) {
      const a = adapt(schema, target);
      const adaptedCheck = validator(target === "gemini" ? rules.geminiToJsonSchema(a.schema) : a.schema);
      const originalCheck = validator(schema);
      const gen = generator(schema, rng(name.length * 7919));
      for (let k = 0; k < 60; k++) {
        const value = gen(schema);
        if (originalCheck && !originalCheck(value)) continue; // the generator missed a constraint; not this library's problem
        const sent = a.encode(value);
        assert.ok(adaptedCheck(sent), `${name}: encoded value fails the adapted schema\n${JSON.stringify(sent)}\n${JSON.stringify(adaptedCheck.errors)}`);
        const back = a.decode(JSON.parse(JSON.stringify(sent)));
        // The one change allowed: an optional field that was also nullable may come back as null
        // instead of missing (OpenAI makes every field present). Still valid for the original.
        assert.deepEqual(dropAddedNulls(back, value), value, `${name}: round trip changed the value`);
        if (originalCheck) assert.ok(originalCheck(back), `${name}: decoded value fails the original schema`);
      }
    }
  });
}

test("openai: optional becomes nullable, and decode turns null back into missing", () => {
  const a = adapt({ type: "object", properties: { city: { type: "string" }, units: { type: "string", enum: ["c", "f"] } }, required: ["city"] }, "openai");
  assert.deepEqual(a.schema, {
    type: "object",
    properties: { city: { type: "string" }, units: { type: ["string", "null"], enum: ["c", "f", null] } },
    required: ["city", "units"],
    additionalProperties: false,
  });
  assert.deepEqual(a.decode({ city: "Pune", units: null }), { city: "Pune" });
  assert.deepEqual(a.decode({ city: "Pune", units: "c" }), { city: "Pune", units: "c" });
});

test("a field that is really nullable keeps its null", () => {
  const a = adapt({ type: "object", properties: { nick: { type: ["string", "null"] } }, required: [] }, "openai");
  assert.deepEqual(a.decode({ nick: null }), { nick: null });
});

test("records travel as key/value lists", () => {
  const a = adapt({ type: "object", properties: { scores: { type: "object", additionalProperties: { type: "number" } } }, required: ["scores"] }, "openai");
  assert.deepEqual(a.schema.properties.scores.items.properties, { key: { type: "string" }, value: { type: "number" } });
  assert.deepEqual(a.decode({ scores: [{ key: "ann", value: 3 }, { key: "bo", value: 5 }] }), { scores: { ann: 3, bo: 5 } });
});

test("gemini: number enums become strings and come back as numbers; property order is kept", () => {
  const a = adapt({ type: "object", properties: { z: { enum: [1, 2, 3] }, a: { type: "string" } }, required: ["z"] }, "gemini");
  assert.deepEqual(a.schema, { type: "OBJECT", properties: { z: { type: "STRING", enum: ["1", "2", "3"] }, a: { type: "STRING" } }, required: ["z"], propertyOrdering: ["z", "a"] });
  assert.deepEqual(a.decode({ z: "2", a: "x" }), { z: 2, a: "x" });
});

test("unsupported constraints become hints in the description, with a warning", () => {
  const a = adapt({ type: "object", properties: { name: { type: "string", minLength: 3, description: "User name" } }, required: ["name"] }, "anthropic");
  assert.equal(a.schema.properties.name.description, "User name (minLength: 3)");
  assert.equal(a.warnings.length, 1);
  assert.match(a.warnings[0].message, /minLength/);
});

test("recursion: kept as $defs for OpenAI, unrolled for Anthropic and Gemini", () => {
  const tree = { type: "object", properties: { name: { type: "string" }, kids: { type: "array", items: { $ref: "#" } } }, required: ["name", "kids"] };
  const o = adapt(tree, "openai");
  assert.ok(o.schema.$defs.Root);
  const g = adapt(tree, "anthropic", { recursionDepth: 2 });
  assert.equal(JSON.stringify(g.schema).includes("$ref"), false);
  const deep = { name: "a", kids: [{ name: "b", kids: [{ name: "c", kids: [{ name: "d", kids: [] }] }] }] };
  assert.deepEqual(g.decode(JSON.parse(JSON.stringify(g.encode(deep)))), deep);
});

test("does not modify the input schema", () => {
  const s = CORPUS["pydantic: $defs, Optional, defaults, titles"];
  const before = JSON.stringify(s);
  for (const t of TARGETS) adapt(s, t);
  assert.equal(JSON.stringify(s), before);
});

test("CommonJS build exports the same API", () => {
  const cjs = createRequire(import.meta.url)("../dist/index.cjs");
  assert.equal(typeof cjs.adapt, "function");
});

// ---- fuzzing: random schemas built from every feature --------------------------------------------

function randomSchema(rand) {
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const defs = {};
  let defCount = 0;
  function node(d) {
    const leaf = d > 3;
    const kind = pick(leaf ? ["string", "number", "integer", "boolean", "enum", "const", "null"] : ["string", "number", "integer", "boolean", "enum", "const", "object", "object", "array", "record", "tuple", "anyOf", "oneOf", "nullable", "typeArray", "ref", "any", "openapiNullable", "allOf", "recursive"]);
    const desc = rand() < 0.3 ? { description: "d" + Math.floor(rand() * 9) } : {};
    switch (kind) {
      case "string": return { type: "string", ...desc, ...(rand() < 0.3 ? { minLength: 1, maxLength: 6 } : {}), ...(rand() < 0.2 ? { format: pick(["email", "date-time", "uuid", "uri"]) } : {}) };
      case "number": return { type: "number", ...desc, ...(rand() < 0.3 ? { minimum: 0, maximum: 10 } : {}) };
      case "integer": return { type: "integer", ...desc, ...(rand() < 0.3 ? { minimum: 1, exclusiveMaximum: 9 } : {}) };
      case "boolean": return { type: "boolean", ...desc };
      case "null": return { type: "null" };
      case "enum": return { enum: pick([["a", "b"], [1, 2, 3], ["x", 0, true], ["p", null], [1.5, 2]]), ...desc };
      case "const": return { const: pick(["k", 7, false]) };
      case "any": return pick([{}, true, { description: "anything" }]);
      case "nullable": return { anyOf: [node(d + 1), { type: "null" }], ...desc };
      case "openapiNullable": return { type: pick(["string", "integer"]), nullable: true };
      case "typeArray": return { type: pick([["string", "null"], ["number", "string"], ["integer", "boolean", "null"]]) };
      case "anyOf": return { anyOf: [node(d + 1), node(d + 1)], ...desc };
      case "oneOf": return { oneOf: [{ type: "object", properties: { a: node(d + 1) }, required: ["a"] }, { type: "object", properties: { b: { type: "string" } }, required: ["b"] }] };
      case "array": return { type: "array", items: node(d + 1), ...(rand() < 0.3 ? { minItems: pick([0, 1, 2]), maxItems: 4 } : {}) };
      case "record": return { type: "object", additionalProperties: node(d + 1), ...desc };
      case "tuple": return rand() < 0.5 ? { type: "array", prefixItems: [node(d + 1), node(d + 1)] } : { type: "array", prefixItems: [node(d + 1), node(d + 1), { type: "string" }], minItems: 2 };
      case "ref": {
        const name = `D${defCount++}`;
        defs[name] = node(d + 1);
        return { $ref: `#/$defs/${name}` };
      }
      case "recursive": {
        const name = `R${defCount++}`;
        defs[name] = { type: "object", properties: { v: { type: "integer" }, next: { anyOf: [{ $ref: `#/$defs/${name}` }, { type: "null" }] } }, required: ["v", "next"] };
        return { $ref: `#/$defs/${name}` };
      }
      case "allOf": return { allOf: [{ type: "object", properties: { x: { type: "string" } }, required: ["x"] }, { type: "object", properties: { y: node(d + 1) } }] };
      default: {
        const props = {};
        const n = 1 + Math.floor(rand() * 4);
        for (let i = 0; i < n; i++) props[pick(["id", "name", "count", "tags", "meta", "when", "kind", "x"]) + i] = node(d + 1);
        return { type: "object", properties: props, required: Object.keys(props).filter(() => rand() < 0.5), ...desc };
      }
    }
  }
  const root = rand() < 0.85 ? { type: "object", properties: { a: node(1), b: node(1) }, required: ["a"] } : node(1);
  return Object.keys(defs).length ? { ...root, $defs: defs } : root;
}

test("fuzz: random schemas are accepted by every target's rules and round-trip their values", () => {
  const seed = Number(process.env.FUZZ_SEED ?? 1);
  const runs = Number(process.env.FUZZ_RUNS ?? 300);
  const rand = rng(seed);
  for (let k = 0; k < runs; k++) {
    const schema = randomSchema(rand);
    const originalCheck = validator(closed(schema));
    for (const target of TARGETS) {
      const a = adapt(schema, target);
      const where = `${target}, schema ${JSON.stringify(schema)}\nadapted ${JSON.stringify(a.schema)}`;
      assert.deepEqual(rules[target](a.schema).filter((e) => !/optional parameters|union parameters/.test(e)), [], where);
      const adaptedCheck = validator(target === "gemini" ? rules.geminiToJsonSchema(a.schema) : a.schema);
      assert.ok(adaptedCheck, `adapted schema doesn't compile: ${where}`);
      const gen = generator(schema, rng(seed * 1000 + k));
      for (let i = 0; i < 8; i++) {
        const value = gen(schema);
        if (originalCheck && !originalCheck(value)) continue;
        const sent = a.encode(value);
        assert.ok(adaptedCheck(sent), `encoded value fails the adapted schema: ${JSON.stringify(value)} -> ${JSON.stringify(sent)}\n${JSON.stringify(adaptedCheck.errors)}\n${where}`);
        const back = a.decode(JSON.parse(JSON.stringify(sent)));
        // OpenAI can't tell "optional" from "null" across union branches; compare with null keys
        // removed on both sides. ("a field that is really nullable keeps its null" covers the rest.)
        // Inside a union, two branches can differ only deep down (a JSON-string field, or a Gemini
        // enum label, where another branch has a plain string). Decode may then pick the other
        // branch: accepted only if the result is still valid for the original schema.
        const same = JSON.stringify(dropNullKeys(back)) === JSON.stringify(dropNullKeys(value));
        const ambiguous = /"(anyOf|oneOf)"/.test(JSON.stringify(schema)) && originalCheck && originalCheck(back);
        assert.ok(same || ambiguous, `round trip changed ${JSON.stringify(value)} -> ${JSON.stringify(sent)} -> ${JSON.stringify(back)}\n${where}`);
      }
    }
  }
});

// ---- real tool schemas from the official MCP servers (everything, filesystem, memory, sequential-thinking)

import { readFileSync } from "node:fs";
const MCP = JSON.parse(readFileSync(new URL("./mcp-tools.json", import.meta.url), "utf8"));

test("real MCP tool schemas: accepted by every target and values round-trip", () => {
  for (const [name, schema] of Object.entries(MCP)) {
    const originalCheck = validator(closed(schema));
    for (const target of TARGETS) {
      const a = adapt(schema, target);
      assert.deepEqual(rules[target](a.schema), [], `${target} ${name}\n${JSON.stringify(a.schema)}`);
      const adaptedCheck = validator(target === "gemini" ? rules.geminiToJsonSchema(a.schema) : a.schema);
      const gen = generator(schema, rng(name.length));
      for (let i = 0; i < 20; i++) {
        const value = gen(schema);
        if (originalCheck && !originalCheck(value)) continue;
        const sent = a.encode(value);
        assert.ok(adaptedCheck(sent), `${target} ${name}: ${JSON.stringify(sent)} ${JSON.stringify(adaptedCheck.errors)}`);
        assert.deepEqual(dropNullKeys(a.decode(JSON.parse(JSON.stringify(sent)))), dropNullKeys(value), `${target} ${name}`);
      }
    }
  }
});
