export type Schema = { [key: string]: any };

/**
 * How to turn a value shaped by the adapted schema back into the original shape (decode), and
 * the other way (encode). Built alongside the adapted schema, one node per schema node.
 */
export type Codec =
  | { t: "id" }
  | { t: "lazy"; get: () => Codec }
  | { t: "wrap"; key: string; inner: Codec }
  | { t: "nullable"; inner: Codec }
  | { t: "obj"; props: Record<string, Codec>; nullMeansMissing: Set<string>; fillWithNull: Set<string> }
  | { t: "arr"; item: Codec }
  | { t: "tuple"; items: Codec[]; minItems: number; padWithNull: boolean; nullableItems: boolean[]; rest?: Codec }
  | { t: "record"; value: Codec }
  | { t: "json" }
  | { t: "enum"; toOriginal: Map<string, unknown>; toLabel: (v: unknown) => string }
  | { t: "any"; options: { codec: Codec; adapted: Schema; original: Schema }[] };

export const ID: Codec = { t: "id" };

export type Resolve = (ref: string) => Schema | undefined;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function decode(c: Codec, v: unknown, resolve: Resolve): unknown {
  switch (c.t) {
    case "id":
      return v;
    case "lazy":
      return decode(c.get(), v, resolve);
    case "wrap":
      return isObject(v) && c.key in v ? decode(c.inner, v[c.key], resolve) : v;
    case "nullable":
      return v === null ? null : decode(c.inner, v, resolve);
    case "obj": {
      if (!isObject(v)) return v;
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        if (val === null && c.nullMeansMissing.has(k)) continue;
        out[k] = c.props[k] ? decode(c.props[k], val, resolve) : val;
      }
      return out;
    }
    case "arr":
      return Array.isArray(v) ? v.map((x) => decode(c.item, x, resolve)) : v;
    case "tuple": {
      if (!isObject(v)) return v;
      const out: unknown[] = [];
      for (let i = 0; i < c.items.length; i++) {
        const x = v[String(i)];
        if (i >= c.minItems && (x === undefined || (x === null && !c.nullableItems[i]))) return out;
        out.push(decode(c.items[i], x, resolve));
      }
      if (c.rest && Array.isArray(v.rest)) for (const x of v.rest) out.push(decode(c.rest, x, resolve));
      return out;
    }
    case "record":
      if (!Array.isArray(v)) return v;
      return Object.fromEntries(v.filter(isObject).map((e) => [String(e.key), decode(c.value, e.value, resolve)]));
    case "json":
      if (typeof v !== "string") return v;
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    case "enum":
      return typeof v === "string" && c.toOriginal.has(v) ? c.toOriginal.get(v) : v;
    case "any": {
      // Adapted objects never have keys beyond the listed ones (Gemini just doesn't say so).
      const pick = c.options.find((o) => fits(v, o.adapted, resolve, { strict: true }));
      return pick ? decode(pick.codec, v, resolve) : v;
    }
  }
}

export function encode(c: Codec, v: unknown, resolve: Resolve): unknown {
  switch (c.t) {
    case "id":
      return v;
    case "lazy":
      return encode(c.get(), v, resolve);
    case "wrap":
      return { [c.key]: encode(c.inner, v, resolve) };
    case "nullable":
      return v === null ? null : encode(c.inner, v, resolve);
    case "obj": {
      if (!isObject(v)) return v;
      const out: Record<string, unknown> = {};
      for (const [k, codec] of Object.entries(c.props)) {
        if (v[k] !== undefined) out[k] = encode(codec, v[k], resolve);
        else if (c.fillWithNull.has(k)) out[k] = null;
      }
      return out;
    }
    case "arr":
      return Array.isArray(v) ? v.map((x) => encode(c.item, x, resolve)) : v;
    case "tuple": {
      if (!Array.isArray(v)) return v;
      const out: Record<string, unknown> = {};
      c.items.forEach((codec, i) => {
        if (i < v.length) out[String(i)] = encode(codec, v[i], resolve);
        else if (c.padWithNull) out[String(i)] = null;
      });
      if (c.rest) out.rest = v.slice(c.items.length).map((x) => encode(c.rest!, x, resolve));
      return out;
    }
    case "record":
      return isObject(v) ? Object.entries(v).map(([key, value]) => ({ key, value: encode(c.value, value, resolve) })) : v;
    case "json":
      return JSON.stringify(v);
    case "enum":
      return c.toLabel(v);
    case "any": {
      // Prefer a branch that declares every key the value has: a looser one would drop some.
      // Most specific first: a branch that declares every key the value has and isn't "anything".
      const tries: FitOptions[] = [{ strict: true, skipAny: true }, { strict: true }, { skipAny: true }, {}];
      let pick;
      for (const t of tries) if ((pick = c.options.find((o) => fits(v, o.original, resolve, t)))) break;
      return pick ? encode(pick.codec, v, resolve) : v;
    }
  }
}

export interface FitOptions {
  /** Treat objects as closed: no keys beyond the listed properties. */
  strict?: boolean;
  /** Let schemas that accept anything ({} or true) match nothing, to find a more specific branch first. */
  skipAny?: boolean;
}

const ANNOTATIONS = new Set(["description", "title", "default", "examples", "$comment", "deprecated", "readOnly", "writeOnly"]);
const acceptsAnything = (s: Schema) => Object.keys(s).every((k) => ANNOTATIONS.has(k));

/**
 * A quick structural check, enough to tell the branches of an anyOf apart. Understands both
 * standard JSON Schema and Gemini's dialect (upper-case types, `nullable`).
 */
export function fits(v: unknown, s: Schema | boolean | undefined, resolve: Resolve, opts: FitOptions = {}, depth = 0): boolean {
  if (s === undefined || s === true) return !opts.skipAny;
  if (s === false) return false;
  if (depth > 50) return true;
  const sub = (x: unknown, schema: Schema | boolean | undefined) => fits(x, schema, resolve, opts, depth + 1);
  if (acceptsAnything(s)) return !opts.skipAny;
  if (typeof s.$ref === "string") return sub(v, resolve(s.$ref));
  if (Array.isArray(s.anyOf) && !s.anyOf.some((b: Schema) => sub(v, b))) return v === null && s.nullable === true;
  if (Array.isArray(s.oneOf) && !s.oneOf.some((b: Schema) => sub(v, b))) return false;
  if (Array.isArray(s.allOf)) {
    // Each branch sees only part of the object, so "no undeclared keys" is checked on the union.
    const loose = { ...opts, strict: false };
    if (!s.allOf.every((b: Schema) => fits(v, b, resolve, loose, depth + 1))) return false;
    if (opts.strict && isObject(v)) {
      const declared = new Set<string>();
      const collect = (b: Schema | undefined): void => {
        if (!isObject(b)) return;
        if (typeof b.$ref === "string") return collect(resolve(b.$ref));
        Object.keys(b.properties ?? {}).forEach((k) => declared.add(k));
        if (Array.isArray(b.allOf)) b.allOf.forEach(collect);
      };
      [s, ...s.allOf].forEach(collect);
      if (Object.keys(v).some((k) => !declared.has(k))) return false;
    }
  }
  if (Array.isArray(s.enum)) return s.enum.some((e: unknown) => same(e, v)) || (v === null && s.nullable === true);
  if ("const" in s) return same(s.const, v);
  const types = typesOf(s);
  if (types && !types.some((t) => typeMatches(t, v))) return false;
  if (typeof v === "number") {
    if (typeof s.minimum === "number" && v < s.minimum) return false;
    if (typeof s.maximum === "number" && v > s.maximum) return false;
    if (typeof s.exclusiveMinimum === "number" && v <= s.exclusiveMinimum) return false;
    if (typeof s.exclusiveMaximum === "number" && v >= s.exclusiveMaximum) return false;
  }
  if (typeof v === "string") {
    if (typeof s.minLength === "number" && v.length < s.minLength) return false;
    if (typeof s.maxLength === "number" && v.length > s.maxLength) return false;
  }
  if (isObject(v)) {
    const extra = s.additionalProperties;
    if (isObject(extra)) for (const [k, x] of Object.entries(v)) if (!s.properties || !(k in s.properties)) if (!sub(x, extra)) return false;
    if (s.properties && types?.includes("object") !== false) {
      for (const r of s.required ?? []) if (!(r in v)) return false;
      if (s.additionalProperties === false || opts.strict) for (const k of Object.keys(v)) if (!(k in s.properties)) return false;
      for (const [k, x] of Object.entries(s.properties)) if (k in v && !sub(v[k], x as Schema)) return false;
    }
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === "number" && v.length < s.minItems) return false;
    if (typeof s.maxItems === "number" && v.length > s.maxItems) return false;
    const tuple = Array.isArray(s.prefixItems) ? s.prefixItems : Array.isArray(s.items) ? s.items : null;
    if (tuple && !tuple.every((p: Schema, i: number) => i >= v.length || sub(v[i], p))) return false;
    if (!tuple && s.items && typeof s.items === "object" && !v.every((x) => sub(x, s.items))) return false;
  }
  return true;
}

function typesOf(s: Schema): string[] | null {
  if (s.type === undefined) return null;
  const list = (Array.isArray(s.type) ? s.type : [s.type]).map((t: string) => String(t).toLowerCase());
  if (s.nullable === true) list.push("null");
  return list;
}

function typeMatches(t: string, v: unknown) {
  switch (t) {
    case "null":
      return v === null;
    case "boolean":
      return typeof v === "boolean";
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "number":
      return typeof v === "number";
    case "string":
      return typeof v === "string";
    case "array":
      return Array.isArray(v);
    case "object":
      return isObject(v);
    default:
      return true;
  }
}

function same(a: unknown, b: unknown) {
  return a === b || (typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b));
}
