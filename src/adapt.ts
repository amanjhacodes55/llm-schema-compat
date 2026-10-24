import { decode as runDecode, encode as runEncode, ID, type Codec, type Resolve, type Schema } from "./codec.js";

export type Target = "openai" | "anthropic" | "gemini";

export interface AdaptOptions {
  /**
   * How many levels deep to unroll a recursive schema for providers that don't support recursion
   * (Anthropic, Gemini). Below that, the value is carried as a JSON string. Default: 3.
   */
  recursionDepth?: number;
}

export interface Warning {
  /** JSON pointer into the original schema. */
  path: string;
  message: string;
}

export interface Adapted {
  /** The schema to send to the provider. */
  schema: Schema;
  /** Turns the model's output back into the shape of your original schema. */
  decode(output: unknown): unknown;
  /** The reverse: turns a value of your original shape into the adapted shape (for few-shot examples, tests). */
  encode(value: unknown): unknown;
  /** Everything that could not be expressed exactly: constraints moved into descriptions, keywords dropped. */
  warnings: Warning[];
}

// What each provider accepts, from its structured-output / strict tool-use documentation.
// Keywords outside these lists are moved into the description as a hint for the model.
const RULES = {
  openai: {
    string: ["pattern", "format"],
    number: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
    array: ["minItems", "maxItems"],
    object: [] as string[],
    formats: ["date-time", "time", "date", "duration", "email", "hostname", "ipv4", "ipv6", "uuid"],
    annotations: ["title", "description"],
  },
  anthropic: {
    string: ["pattern", "format"],
    number: [] as string[],
    array: ["minItems"],
    object: [] as string[],
    formats: ["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"],
    annotations: ["title", "description", "default"],
  },
  gemini: {
    string: ["pattern", "format", "minLength", "maxLength"],
    number: ["minimum", "maximum"],
    array: ["minItems", "maxItems"],
    object: ["minProperties", "maxProperties"],
    formats: ["date-time"],
    annotations: ["title", "description", "default"],
  },
} satisfies Record<Target, Record<string, string[]>>;

// Never sent anywhere: meta and editor keywords that carry no meaning for generation.
const SILENT = new Set(["$schema", "$id", "$anchor", "$dynamicAnchor", "$comment", "$vocabulary", "readOnly", "writeOnly", "deprecated", "contentEncoding", "contentMediaType", "discriminator", "xml", "externalDocs", "x-stainless-any"]);
const STRUCTURE = new Set(["type", "properties", "required", "additionalProperties", "items", "prefixItems", "anyOf", "oneOf", "allOf", "enum", "const", "$ref", "$defs", "definitions", "nullable"]);

const isObject = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);

type Out = { schema: Schema; codec: Codec; nullable: boolean };

class Adapter {
  readonly warnings: Warning[] = [];
  private readonly defs: Record<string, Schema> = {};
  private readonly defCodecs = new Map<string, Codec>();
  private readonly defNullable = new Map<string, boolean>();
  private readonly defNames = new Map<string, string>();
  private readonly inlining: string[] = [];

  constructor(
    private readonly root: Schema,
    private readonly target: Target,
    private readonly depth: number,
  ) {}

  run(): { schema: Schema; codec: Codec } {
    const top = this.convert(this.root, "#");
    let schema = top.schema;
    let codec = top.codec;
    const isPlainObject = schema.type === "object" || schema.type === "OBJECT";
    if (!isPlainObject || top.nullable) {
      // Every provider wants an object at the top of a tool's parameters (OpenAI for any strict
      // schema). Anything else is wrapped in { value } and unwrapped by decode().
      this.warn("#", "root is not an object; wrapped as { value: ... }");
      schema = this.object({ value: top.nullable ? this.nullable(top.schema) : top.schema }, ["value"]);
      codec = { t: "wrap", key: "value", inner: codec };
    }
    if (Object.keys(this.defs).length) schema = { ...schema, $defs: this.defs };
    this.checkLimits(schema);
    return { schema, codec };
  }

  /** The documented size limits. Exceeding them is a 400 from the provider, so say so up front. */
  private checkLimits(schema: Schema) {
    let optional = 0;
    let unions = 0;
    let properties = 0;
    let enums = 0;
    let depth = 0;
    const walk = (s: Schema, d: number) => {
      if (!isObject(s)) return;
      depth = Math.max(depth, d);
      const props = isObject(s.properties) ? s.properties : {};
      properties += Object.keys(props).length;
      optional += Object.keys(props).filter((k) => !(s.required ?? []).includes(k)).length;
      if (s.anyOf || Array.isArray(s.type)) unions++;
      if (Array.isArray(s.enum)) enums += s.enum.length;
      Object.values(props).forEach((p) => walk(p as Schema, d + 1));
      if (isObject(s.items)) walk(s.items, d + 1);
      (s.anyOf ?? []).forEach((b: Schema) => walk(b, d));
      Object.values(s.$defs ?? {}).forEach((b) => walk(b as Schema, 0));
    };
    walk(schema, 0);
    if (this.target === "anthropic") {
      if (optional > 24) this.warn("#", `${optional} optional parameters; Anthropic allows 24 across all strict tools in a request`);
      if (unions > 16) this.warn("#", `${unions} union-typed parameters; Anthropic allows 16 across all strict tools in a request`);
    }
    if (this.target === "openai") {
      if (depth > 10) this.warn("#", `nested ${depth} levels deep; OpenAI allows 10`);
      if (properties > 5000) this.warn("#", `${properties} properties; OpenAI allows 5000`);
      if (enums > 1000) this.warn("#", `${enums} enum values; OpenAI allows 1000`);
    }
  }

  private warn(path: string, message: string) {
    this.warnings.push({ path, message });
  }

  private resolve: Resolve = (ref) => {
    if (ref === "#") return this.root;
    if (!ref.startsWith("#/")) return undefined;
    let node: any = this.root;
    for (const raw of ref.slice(2).split("/")) {
      const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
      node = node?.[key];
    }
    return isObject(node) || typeof node === "boolean" ? (node as Schema) : undefined;
  };

  private type(t: string) {
    return this.target === "gemini" ? t.toUpperCase() : t;
  }

  private object(props: Record<string, Schema>, required: string[]): Schema {
    const s: Schema = { type: this.type("object"), properties: props };
    if (required.length || this.target === "openai") s.required = required;
    if (this.target === "gemini") s.propertyOrdering = Object.keys(props);
    else s.additionalProperties = false;
    return s;
  }

  private nullable(s: Schema): Schema {
    if (this.target === "gemini") {
      if (s.anyOf) return { ...s, anyOf: [...s.anyOf, { type: "NULL" }] };
      return { ...s, nullable: true };
    }
    if ("const" in s) {
      const { const: c, ...rest } = s;
      return this.nullable({ ...rest, enum: [c] });
    }
    if (s.$ref || s.anyOf || !s.type) return { anyOf: [...(s.anyOf ?? [s.$ref ? { $ref: s.$ref } : s]), { type: "null" }] };
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const out: Schema = { ...s, type: types.includes("null") ? types : [...types, "null"] };
    if (Array.isArray(s.enum) && !s.enum.includes(null)) out.enum = [...s.enum, null];
    return out;
  }

  /** The same value, or null. null passes straight through decode/encode. */
  private orNull(out: Out): Out {
    return { schema: this.nullable(out.schema), codec: out.codec === ID ? ID : { t: "nullable", inner: out.codec }, nullable: true };
  }

  /** A value with no usable shape travels as a JSON string. */
  private json(node: Schema, why: string): Out {
    const desc = [node.description, `JSON-encoded value${why ? ` (${why})` : ""}`].filter(Boolean).join(". ");
    return { schema: { type: this.type("string"), description: desc }, codec: { t: "json" }, nullable: false };
  }

  private convert(input: Schema | boolean, path: string): Out {
    if (input === true || input === undefined) return this.json({}, "");
    if (input === false) {
      this.warn(path, "`false` schema (no value allowed) can't be expressed; treated as any value");
      return this.json({}, "");
    }
    let node: Schema = input;

    if (typeof node.$ref === "string") return this.ref(node, path);
    if (Array.isArray(node.allOf)) return this.convert(this.mergeAllOf(node, path), path);
    const union = node.anyOf ?? node.oneOf;
    if (Array.isArray(union)) return this.union(node, union, path);

    // Normalise the dialects: OpenAPI's `nullable`, draft-04 boolean exclusive bounds,
    // draft-07 array-form `items` (tuples).
    let nullable = node.nullable === true;
    let types: string[] = node.type === undefined ? [] : Array.isArray(node.type) ? [...node.type] : [node.type];
    types = types.map((t) => String(t).toLowerCase());
    if (types.includes("null")) {
      nullable = true;
      types = types.filter((t) => t !== "null");
    }
    if (Array.isArray(node.items)) node = { ...node, prefixItems: node.items, items: node.additionalItems };
    for (const [ex, bound] of [["exclusiveMinimum", "minimum"], ["exclusiveMaximum", "maximum"]] as const) {
      if (typeof node[ex] === "boolean") node = node[ex] ? { ...node, [ex]: node[bound], [bound]: undefined } : { ...node, [ex]: undefined };
    }

    let out: Out;
    if (Array.isArray(node.enum) || "const" in node) out = this.enumeration(node, path);
    else {
      if (!types.length) {
        if (node.properties || node.additionalProperties !== undefined || node.patternProperties) types = ["object"];
        else if (node.items || node.prefixItems) types = ["array"];
      }
      if (types.length > 1) {
        // ["string", "number"]: one branch per type, each with the keywords that apply to it.
        const branches = types.map((t) => ({ ...node, type: t, nullable: undefined }));
        out = this.union(node, branches, path);
      } else if (types.length === 0) {
        if (nullable) {
          out = { schema: { type: this.type("null") }, codec: ID, nullable: true };
          nullable = false;
        } else out = this.json(node, "");
      } else out = this.typed(node, types[0], path);
    }
    if (nullable && !out.nullable) out = this.orNull(out);
    return out;
  }

  private typed(node: Schema, type: string, path: string): Out {
    switch (type) {
      case "object":
        return this.objectNode(node, path);
      case "array":
        return this.arrayNode(node, path);
      case "string":
      case "number":
      case "integer":
      case "boolean":
        return { schema: this.keywords(node, { type: this.type(type) }, type === "integer" ? "number" : type, path), codec: ID, nullable: false };
      default:
        this.warn(path, `unknown type "${type}"; treated as any value`);
        return this.json(node, "");
    }
  }

  /** Copies the keywords the target supports for this kind of value; the rest become a hint. */
  private keywords(node: Schema, out: Schema, kind: string, path: string): Schema {
    const rules = RULES[this.target];
    const allowed = new Set<string>([...((rules as any)[kind] ?? []), ...rules.annotations]);
    const hints: string[] = [];
    for (const [k, v] of Object.entries(node)) {
      if (v === undefined || STRUCTURE.has(k) || SILENT.has(k) || k === "items" || k.startsWith("x-")) continue;
      if (k === "format" && typeof v === "string" && !rules.formats.includes(v)) {
        hints.push(`format: ${v}`);
        continue;
      }
      if (k === "pattern" && this.target === "anthropic" && /\(\?[=!<]|\\[1-9bB]|\{\d+,\d{3,}\}/.test(String(v))) {
        hints.push(`pattern: ${v}`);
        continue;
      }
      if (k === "minItems" && this.target === "anthropic" && v !== 0 && v !== 1) {
        hints.push(`minItems: ${v}`);
        continue;
      }
      if (allowed.has(k)) out[k] = v;
      else if (k !== "title" && k !== "description" && k !== "propertyOrdering") hints.push(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
    }
    if (hints.length) {
      this.warn(path, `not supported by ${this.target}, moved to the description: ${hints.join("; ")}`);
      out.description = [out.description, `(${hints.join("; ")})`].filter(Boolean).join(" ");
    }
    return out;
  }

  private objectNode(node: Schema, path: string): Out {
    const props: Record<string, Schema> = isObject(node.properties) ? node.properties : {};
    const extra = node.additionalProperties;
    const hasProps = Object.keys(props).length > 0;

    if (!hasProps) {
      // A map ({ [key: string]: T }): no provider's strict mode can say "any key". Sent as a
      // list of { key, value } pairs instead, and rebuilt into an object by decode().
      const valueSchema = isObject(extra) && Object.keys(extra).length ? extra : node.patternProperties ? { anyOf: Object.values(node.patternProperties) } : null;
      if (valueSchema) {
        const value = this.convert(valueSchema, `${path}/additionalProperties`);
        const entry = this.object({ key: { type: this.type("string") }, value: value.schema }, ["key", "value"]);
        const schema = this.keywords(node, { type: this.type("array"), items: entry }, "object", path);
        schema.description = [schema.description, "(entries of a map, as key/value pairs)"].filter(Boolean).join(" ");
        return { schema, codec: { t: "record", value: value.codec }, nullable: false };
      }
      const anyValue = extra === true || (isObject(extra) && !Object.keys(extra).length);
      if (anyValue || (extra === undefined && !("properties" in node) && path !== "#")) return this.json(node, "any object");
    } else if (extra !== undefined && extra !== false) {
      this.warn(path, "extra properties beyond the listed ones can't be expressed and were dropped");
    }

    const required = new Set<string>(Array.isArray(node.required) ? node.required : []);
    const outProps: Record<string, Schema> = {};
    const codecs: Record<string, Codec> = {};
    const nullMeansMissing = new Set<string>();
    const fillWithNull = new Set<string>();
    for (const [k, sub] of Object.entries(props)) {
      const p = this.convert(sub as Schema, `${path}/properties/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`);
      let schema = p.schema;
      if (this.target === "openai" && !required.has(k)) {
        // OpenAI strict mode: every property is required, so "optional" becomes "may be null".
        // decode() turns that null back into a missing key (unless null was a real value).
        fillWithNull.add(k);
        if (!p.nullable) {
          schema = this.nullable(schema);
          nullMeansMissing.add(k);
        }
      }
      outProps[k] = schema;
      codecs[k] = p.codec;
    }
    const req = this.target === "openai" ? Object.keys(props) : Object.keys(props).filter((k) => required.has(k));
    const schema = this.keywords(node, this.object(outProps, req), "object", path);
    const identity = !fillWithNull.size && Object.values(codecs).every((c) => c === ID);
    return { schema, codec: identity ? ID : { t: "obj", props: codecs, nullMeansMissing, fillWithNull }, nullable: false };
  }

  private arrayNode(node: Schema, path: string): Out {
    if (Array.isArray(node.prefixItems)) {
      // A tuple ([string, number]): sent as an object with keys "0", "1", ... and turned back
      // into an array by decode(). Provider schemas can't describe position-dependent items.
      const parts: Out[] = node.prefixItems.map((s: Schema, i: number) => this.convert(s, `${path}/prefixItems/${i}`));
      const props: Record<string, Schema> = Object.fromEntries(parts.map((p, i) => [String(i), p.schema]));
      // JSON Schema: without minItems, every position is optional.
      const min = Math.min(typeof node.minItems === "number" ? node.minItems : 0, parts.length);
      const required = parts.map((_, i) => String(i)).filter((_, i) => i < min || this.target === "openai");
      if (this.target === "openai") for (let i = min; i < parts.length; i++) if (!parts[i].nullable) props[String(i)] = this.nullable(props[String(i)]);
      // Items after the fixed positions (a "rest" element) go in a list of their own.
      let rest: Out | undefined;
      if (isObject(node.items) || node.items === true) {
        rest = this.convert(node.items, `${path}/items`);
        props.rest = { type: this.type("array"), items: rest.schema };
        if (this.target === "openai") required.push("rest");
      }
      const schema = this.object(props, required);
      if (node.description) schema.description = node.description;
      schema.description = [schema.description, `(a tuple: fill keys in order${rest ? ', then any further items in "rest"' : ""})`].filter(Boolean).join(" ");
      return {
        schema,
        codec: { t: "tuple", items: parts.map((p) => p.codec), minItems: min, padWithNull: this.target === "openai", nullableItems: parts.map((p) => p.nullable), rest: rest?.codec },
        nullable: false,
      };
    }
    const item = node.items && typeof node.items === "object" ? this.convert(node.items, `${path}/items`) : this.json({}, "");
    const schema = this.keywords(node, { type: this.type("array"), items: item.schema }, "array", path);
    return { schema, codec: item.codec === ID ? ID : { t: "arr", item: item.codec }, nullable: false };
  }

  private enumeration(node: Schema, path: string): Out {
    const values: unknown[] = Array.isArray(node.enum) ? node.enum : [node.const];
    const nonNull = values.filter((v) => v !== null);
    const nullable = nonNull.length < values.length;
    const complex = nonNull.some((v) => typeof v === "object");
    const annotate = (s: Schema) => this.keywords({ description: node.description, title: node.title, default: node.default }, s, "", path);

    if (complex) {
      this.warn(path, "enum of objects or arrays isn't supported; values are sent as JSON strings");
    }
    if (this.target === "gemini" || complex) {
      // Gemini enums are strings only: other values travel as their JSON text, mapped back by decode().
      const label = (v: unknown) => (typeof v === "string" && !complex && nonNull.every((x) => typeof x === "string") ? v : JSON.stringify(v));
      const toOriginal = new Map(nonNull.map((v) => [label(v), v] as const));
      const schema = annotate({ type: this.type("string"), enum: [...toOriginal.keys()] });
      const identity = nonNull.every((v) => typeof v === "string") && !complex;
      const out: Out = { schema, codec: identity ? ID : { t: "enum", toOriginal, toLabel: label }, nullable: false };
      return nullable ? this.orNull(out) : out;
    }
    const kinds = [...new Set(nonNull.map((v) => (typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v)))];
    const type = kinds.length === 1 ? kinds[0] : kinds.includes("number") && kinds.every((k) => k === "number" || k === "integer") ? "number" : undefined;
    const schema: Schema = type ? { type } : {};
    if (this.target === "anthropic" && !Array.isArray(node.enum)) schema.const = node.const;
    else schema.enum = nonNull;
    const out: Out = { schema: annotate(schema), codec: ID, nullable: false };
    return nullable ? this.orNull(out) : out;
  }

  private union(node: Schema, input: (Schema | boolean)[], path: string): Out {
    // anyOf inside anyOf is the same as one flat anyOf, and flat is what lets the checks below
    // see every branch side by side.
    const flatten = (list: (Schema | boolean)[]): (Schema | boolean)[] =>
      list.flatMap((b) => {
        if (!isObject(b)) return [b];
        const inner = b.anyOf ?? b.oneOf;
        const onlyUnion = Array.isArray(inner) && Object.keys(b).every((k) => ["anyOf", "oneOf", "description", "title"].includes(k));
        return onlyUnion ? flatten(inner) : [b];
      });
    const branches = flatten(input);
    const isNull = (b: Schema | boolean) => isObject(b) && (b.type === "null" || (Array.isArray(b.enum) && b.enum.length === 1 && b.enum[0] === null) || b.const === null);
    const nullable = branches.some(isNull) || node.nullable === true;
    const rest = branches.filter((b) => !isNull(b));
    const key = node.anyOf ? "anyOf" : node.oneOf ? "oneOf" : "type";
    if (node.oneOf) this.warn(path, "oneOf sent as anyOf (no provider supports oneOf); exactly-one is no longer enforced");
    const parts = rest.map((b, i) => ({ out: this.convert(b, `${path}/${key}/${i}`), original: b }));
    // Some branches change kind on the way: a map becomes a list of pairs, a tuple an object, a
    // free-form value or a Gemini number enum a string. Next to a real branch of that kind, the
    // model's answer couldn't be told apart, so such a branch goes inside { <key>: ... } instead.
    // (An OpenAI $ref is looked through to its definition.)
    const deref = (sch: Schema): Schema => (typeof sch.$ref === "string" && sch.$ref.startsWith("#/$defs/") ? (this.defs[sch.$ref.slice(8)] ?? sch) : sch);
    const kind = (raw: Schema): string => {
      const sch = deref(raw);
      return String([].concat(sch.type ?? (sch.anyOf ? "union" : "any")).find((t) => String(t).toLowerCase() !== "null") ?? "null").toLowerCase();
    };
    const changesKind = (c: Codec): string | null =>
      c.t === "nullable" || c.t === "lazy"
        ? changesKind(c.t === "lazy" ? c.get() : c.inner)
        : c.t === "record" ? "entries" : c.t === "tuple" ? "items" : c.t === "json" ? "json" : c.t === "enum" ? "choice" : null;
    for (const p of parts) {
      const key = changesKind(p.out.codec);
      const clash = (q: Out) => ["union", "any"].includes(kind(q.schema)) || kind(q.schema) === kind(p.out.schema);
      if (!key || !parts.some((q) => q !== p && clash(q.out))) continue;
      p.out = { schema: this.object({ [key]: p.out.schema }, [key]), codec: { t: "wrap", key, inner: p.out.codec }, nullable: false };
    }
    let result: Out;
    if (parts.length === 0) result = { schema: { type: this.type("null") }, codec: ID, nullable: true };
    else if (parts.length === 1) result = parts[0].out;
    else {
      const schema: Schema = { anyOf: parts.map((p) => p.out.schema) };
      const identity = parts.every((p) => p.out.codec === ID);
      result = {
        schema,
        codec: identity ? ID : { t: "any", options: parts.map((p) => ({ codec: p.out.codec, adapted: p.out.schema, original: p.original as Schema })) },
        // A union can take null if any branch can.
        nullable: parts.some((p) => p.out.nullable),
      };
    }
    // OpenAI allows nothing beside a $ref, so a description can't go there.
    if (node.description && !result.schema.description && !result.schema.$ref) result = { ...result, schema: { ...result.schema, description: node.description } };
    if (nullable && !result.nullable) result = this.orNull(result);
    return result;
  }

  /** allOf: object branches are merged into one; anything else keeps the first branch. */
  private mergeAllOf(node: Schema, path: string): Schema {
    const { allOf, ...base } = node;
    let merged: Schema = { ...base };
    for (const raw of allOf as Schema[]) {
      const b = isObject(raw) && typeof raw.$ref === "string" ? { ...this.resolve(raw.$ref), ...raw, $ref: undefined } : raw;
      if (!isObject(b)) continue;
      const inner = Array.isArray(b.allOf) ? this.mergeAllOf(b, path) : b;
      if (inner.properties || inner.type === "object") {
        merged = {
          ...inner,
          ...merged,
          type: "object",
          properties: { ...(merged.properties ?? {}), ...(inner.properties ?? {}) },
          required: [...new Set([...(merged.required ?? []), ...(inner.required ?? [])])],
        };
      } else if (!merged.type && !merged.properties) merged = { ...inner, ...merged };
      else this.warn(path, "allOf branch that isn't an object couldn't be merged and was dropped");
    }
    delete merged.$ref;
    return merged;
  }

  private ref(node: Schema, path: string): Out {
    const ref: string = node.$ref;
    const target = this.resolve(ref);
    if (target === undefined) {
      this.warn(path, `can't resolve $ref "${ref}" (only local refs are supported); treated as any value`);
      return this.json(node, "");
    }
    const { $ref, ...siblings } = node;
    const extra = Object.keys(siblings).filter((k) => !["description", "title", "default", "examples"].includes(k));
    if (extra.length) return this.convert(this.mergeAllOf({ allOf: [{ $ref }, siblings] }, path), path);

    if (this.target !== "openai") {
      // Anthropic and Gemini get every reference inlined. A recursive one is unrolled a few
      // levels and then carried as a JSON string.
      const seen = this.inlining.filter((r) => r === ref).length;
      if (seen >= this.depth) {
        this.warn(path, `recursive schema "${ref}" unrolled ${this.depth} levels deep; deeper values are JSON strings`);
        return this.json(isObject(target) ? { description: target.description } : {}, "recursive");
      }
      this.inlining.push(ref);
      const out = this.convert(isObject(target) ? { ...target, ...siblings } : target, path);
      this.inlining.pop();
      return out;
    }

    // OpenAI supports $defs and recursion, but a $ref may have no keywords beside it.
    let name = this.defNames.get(ref);
    if (!name) {
      const base = (ref === "#" ? "Root" : (ref.split("/").pop() ?? "Def")).replace(/[^A-Za-z0-9_-]/g, "_") || "Def";
      name = base;
      for (let i = 2; this.defCodecs.has(name) || this.defs[name]; i++) name = `${base}${i}`;
      this.defNames.set(ref, name);
      this.defCodecs.set(name, ID);
      const out = this.convert(target, ref);
      this.defs[name] = out.schema;
      this.defCodecs.set(name, out.codec);
      this.defNullable.set(name, out.nullable);
    }
    const defName = name;
    const codec: Codec = { t: "lazy", get: () => this.defCodecs.get(defName) ?? ID };
    if (siblings.description) this.warn(path, "description beside $ref dropped (OpenAI allows no keywords next to $ref)");
    // While a recursive definition is still being converted, fall back to a direct look.
    const nullable = this.defNullable.get(defName) ?? this.isNullable(target);
    return { schema: { $ref: `#/$defs/${defName}` }, codec, nullable };
  }

  private isNullable(s: Schema | boolean): boolean {
    if (!isObject(s)) return false;
    if (s.nullable === true || s.type === "null" || (Array.isArray(s.type) && s.type.includes("null"))) return true;
    const union = s.anyOf ?? s.oneOf;
    return Array.isArray(union) && union.some((b: Schema) => isObject(b) && (b.type === "null" || b.const === null));
  }
}

/**
 * Rewrites a JSON Schema so `target` accepts it for tool parameters or structured output, and
 * returns decode()/encode() to move values between the adapted shape and the original one.
 */
export function adapt(schema: Schema | boolean, target: Target, options: AdaptOptions = {}): Adapted {
  if (!["openai", "anthropic", "gemini"].includes(target)) throw new TypeError(`llm-schema-compat: unknown target "${target}"`);
  const root: Schema = isObject(schema) ? structuredClone(schema) : {};
  const adapter = new Adapter(root, target, options.recursionDepth ?? 3);
  const { schema: out, codec } = adapter.run();
  const resolveOut: Resolve = (ref) => (ref.startsWith("#/$defs/") ? out.$defs?.[ref.slice(8)] : undefined);
  const resolveIn: Resolve = (ref) => {
    if (ref === "#") return root;
    let node: any = root;
    for (const raw of ref.replace(/^#\//, "").split("/")) node = node?.[decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~")];
    return node;
  };
  return {
    schema: out,
    decode: (v) => runDecode(codec, v, resolveOut),
    encode: (v) => runEncode(codec, v, resolveIn),
    warnings: adapter.warnings,
  };
}
