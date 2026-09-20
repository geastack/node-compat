// WHATWG Fetch/URL globals for node-compat, compiled by geatsc. These back the
// ambient globals (`Response`, `Request`, `Headers`, `URL`, `URLSearchParams`,
// `FormData`) that real libraries (hono, fastify adapters) construct — e.g.
// hono's `c.text()`/`c.json()` do `new Response(body, { status, headers })`.
//
// This file has NO top-level `import`/`export`, which is deliberate and
// load-bearing: a file with neither is a TypeScript SCRIPT rather than a
// module, and a script's top-level declarations land in the real global
// scope automatically — the same scope `lib.dom.d.ts` declares `Response`
// into. That is what makes `new Response()` in library code (compiled from
// source, with no import of this file in sight) resolve to THESE classes "by
// name": there is no other mechanism that could do it, and there used to be
// none here either — this file used to `export class Headers {...}` etc,
// which makes every one of these names MODULE-scoped, invisible to any file
// that does not import them. Nothing does. Under the generated tsconfig
// (`scripts/build.mjs`), `'DOM'` was still in `compilerOptions.lib`, so
// `new Response()` resolved to `lib.dom.d.ts`'s ambient, unimplemented
// interface instead — silently, because both are legal "Response" as far as
// the checker's error output is concerned. Verify with
// `.scratch/probe-resolve.mjs <tsconfig>`: every name below must resolve to
// a declaration IN THIS FILE, never to `lib.dom.d.ts`.
//
// Rooted by `build.mjs` when the reachable runtime/declaration graph has an
// unbound name this file implements. `--globals` remains an explicit override,
// but ordinary Fastify and `whatwg-url` package resolution needs no flag.
//
// The ambient, no-implementation names this file's TAIL still needs
// (`BufferSource`, `queueMicrotask`'s siblings) that node-compat's own
// builtins rely on regardless of this conditional root live in
// `standard-library.ts` instead, unconditionally included -- see that file's
// header for why the split.

// WHATWG Fetch's `Headers` constructor argument union. A named alias, not
// only the inline unions `ResponseInit.headers`/`RequestInit.headers` already
// state (see those fields' own comments for why THEY stay inline): outside
// callers -- `@hono/node-server`'s own `response.ts`/`utils.ts` -- spell this
// type BY NAME, with no import, exactly like `Response`/`Headers` themselves.
type HeadersInit = Headers | Record<string, string> | [string, string][];

// WHATWG Fetch's `Headers.keys()`/`.values()`/`.entries()` return type.
// Aliased directly to `Generator<T>`, not a separate nominal interface,
// because `Headers`'s own iteration methods (below) already return real
// `Generator<T>` values -- the one literal annotation geatsc maps to its
// native `iterator` cursor kind (see `Headers[Symbol.iterator]`'s own
// comment, further down, for the two traps that shape depends on). A
// distinct `interface HeadersIterator<T>` here would type-check identically
// for every caller but force a lossy conversion at the one place that
// matters: `Headers`'s own methods returning it.
type HeadersIterator<T> = Generator<T>;

// The implementation is named `HeadersImpl`, not `Headers` -- the bare name
// `Headers` is declared further down as a TYPE ALIAS plus a separate `var`,
// and load-bearing, not decoration. `@hono/node-server`'s own
// `headers.ts`/`websocket.ts` read `globalThis.Headers` (feature-detecting a
// real WHATWG implementation before falling back to their own), which needs
// `Headers` reflected onto `typeof globalThis` -- and real JavaScript only
// ever adds a top-level `var`/`function` declaration to the global OBJECT;
// `class`/`let`/`const` never do, in a browser or in Node (verified against
// this checker too: a plain `class Headers {}` here stayed a resolvable bare
// name but never appeared on `typeof globalThis`). A `class Headers` and a
// `var Headers` of the same name in the SAME scope collide outright
// ("Duplicate identifier"), because a class occupies both the type and the
// value space at once -- so the implementation has to live under a
// different name, with `Headers` itself assembled from a type half (`type
// Headers = HeadersImpl`) and a value half (`var Headers: typeof
// HeadersImpl = HeadersImpl`) that merge cleanly because each occupies only
// ONE of those two spaces. This is the same split `@types/node`'s own
// `globals.d.ts` uses for this exact name (`interface Headers extends
// _Headers {}` beside `var Headers: ...`) -- not invented here, matched.
// `Response`/`Request`/`CloseEvent`/`ErrorEvent` below get the identical
// treatment for the identical reason: each is read off `global`/`globalThis`
// by name somewhere in `@hono/node-server`.
class HeadersImpl {
  // Allocated on the first insertion. A request builds two or three Headers
  // (its own, the Response's, hono's copy in newResponse) and most stay empty
  // or see one entry; two eager arrays per instance were four to six pooled
  // allocations and as many cycle-collector candidates per request.
  //
  // Every method that reads these two fields through `this` is one that
  // `@hono/node-server`'s lightweight `RequestHeaders` overrides. That class
  // is re-parented onto this one (`Object.setPrototypeOf`), which the
  // compiler admits only while each inherited member reaches `this` solely
  // to look up a method (see semantics/prototype-reparenting.ts). Helpers
  // that need the arrays without being overridden (`wireLinesOf`) are
  // therefore static, and there is no private field-reading instance helper.
  private headerNames: string[] | undefined = undefined;
  private headerValues: string[] | undefined = undefined;

  // NOT a genuine dynamic boundary, despite reaching here across every
  // library call site: this shim's own `Response.headers` field (below) is
  // typed `Headers`, never `any`, so the two real callers -- hono's
  // `context.ts#newResponse`, `new Headers(this.#res.headers)` and
  // `new Headers(arg.headers)` (the latter's `instanceof Headers` already
  // excluded by the caller before it ever reaches here) -- hand this exactly
  // WHATWG's own `HeadersInit` union (`Headers | string[][] |
  // Record<string, string>`), stated below rather than widened to `any`.
  // Narrowing this turns `init instanceof Headers` from a boxed runtime test
  // (`runtime-helper:computation:instanceof:dynamic:constructor-family`,
  // which `emit-instanceof.ts` refuses -- no runtime class identity exists
  // for a boxed program class) into a tagged-union discriminant the checker
  // already proved, which `constructorFamilyInstanceofText`'s own
  // `tagged-union` arm renders with no runtime helper at all. The same
  // pattern already stands proven in this file: `Response`'s own constructor
  // (below) does `h instanceof Headers` against `h: ResponseInit['headers']`
  // -- a real union, not `any` -- and raises no such obligation.
  //
  // The default is `undefined`, NOT `{}`: `new Headers()` runs 2-3 times per
  // request (Request/Response field initializers), and a `{}` default paid a
  // record allocation plus a dynamic `init.count` probe and a for-in walk on
  // every one of those calls — for zero entries. An optional parameter (no
  // default expression at all) keeps that -- zero evaluation on the common,
  // argument-less path -- without needing a placeholder default value.
  constructor(init?: Headers | Record<string, string> | [string, string][]) {
    if (init === undefined || init === null) return;
    if (init instanceof Headers) {
      // A native copy, and no duck-typed fallback behind it. There used to be
      // one: when this parameter was `any`, a boxed `Headers` that had lost
      // its native identity (a "record mirror") arrived as an empty handle,
      // and the recovery read index accessors (since removed) back off a
      // cast. `init` is this shim's own union now, so `instanceof Headers`
      // here is a tagged-union discriminant over a native handle rather than
      // a runtime identity test on a box -- if this arm is live the handle is
      // real, and there is no lost identity left to recover from. The
      // recovery also never shipped: writing a `Headers` into a
      // record-of-methods cell is a conversion this backend does not install,
      // so the cast refused emission for the whole program.
      this.copyFrom(init);
      return;
    }
    // The remaining shape is a plain object OR an array of pairs, and the two
    // are SPLIT here rather than enumerated together. Enumerating the union
    // itself is a capability this backend does not render (`for`-`in` over a
    // `tagged-union` carrier: `runtime-helper-key.ts`'s
    // `protocolSourceCarrierKind` keys a for-in target by its own
    // representation kind, and "tagged-union" is not one `emit-iterator.ts`
    // claims a render for), and the previous repair for that was to hand the
    // union to a method with a genuinely `any`-typed parameter -- a real
    // parameter boundary, so the walk got the `dynamic` carrier it needed.
    //
    // That worked and cost more than it looked. `ir/shake.ts` prunes a class
    // member by the KEYS the program still spells, and a computed-key access
    // on a boxed receiver is a key it cannot name -- so one `source[key]` in
    // this file was, for a while, the single fact that kept every field of
    // every class in every program reachable. `Array.isArray` costs nothing
    // and removes the box: what is left after it is `Record<string, string>`,
    // whose for-in walks a native key table (`hasNativeEnumerationCursor`).
    //
    // It also fixes what the `any` walk got WRONG. WHATWG keys array-of-pairs
    // input by each pair's own [0]/[1] (Fetch 2.2.1's "fill" over a sequence
    // of sequences), and enumerating the array with for-in produced the
    // INDICES as header names -- a pre-existing defect the union type was
    // always precise enough to state and the `any` walk erased.
    if (Array.isArray(init)) {
      for (const pair of init) this.set(pair[0], pair[1]);
      return;
    }
    for (const key in init) this.set(key, init[key]);
  }

  // HeadersInit's instanceof branch supplies this native handle directly.
  // No boxed mirror or dynamic property recovery is involved in copying it.
  // Read through `forEach`, the public iteration a subclass overrides, never
  // this class's own storage: `@hono/node-server`'s lazy `RequestHeaders`
  // extends `Headers` with an empty base and answers every accessor from the
  // incoming message, so a storage walk copied zero headers and a multipart
  // request lost its `content-type`.
  copyFrom(source: Headers): boolean {
    if (!source) return false;
    source.forEach((value, name) => this.append(name, value));
    return true;
  }

  // The reactor hands a request's header block over as ONE string, one
  // "Name: value\r\n" per line (the same wire form `IncomingMessage#rawHeaders`
  // splits). Parsed straight into the two arrays here, one lowercase per
  // name, instead of the three stops the node:http adapter path paid --
  // the [name, value, ...] array, the plain `headers` object, and a
  // `for`-`in` re-copy into `new Headers(object)`. Duplicates join the way
  // Node's `IncomingMessage#headers` joins them (`; ` for cookie, `, ` for
  // the rest), which is also what WHATWG's `Headers#get` returns for a
  // multi-valued name. Called lazily by `Request#headers`, so a route that
  // never reads a header never pays for parsing one.
  static fromRawHead(head: string): Headers {
    const headers = new Headers();
    const names: string[] = [];
    const values: string[] = [];
    headers.headerNames = names;
    headers.headerValues = values;
    const length = head.length;
    let pos = 0;
    while (pos < length) {
      let eol = head.indexOf("\r\n", pos);
      if (eol < 0) eol = length;
      const colon = head.indexOf(":", pos);
      if (colon > pos && colon < eol) {
        let valueStart = colon + 1;
        while (valueStart < eol && (head[valueStart] === " " || head[valueStart] === "\t")) valueStart++;
        let valueEnd = eol;
        while (valueEnd > valueStart && (head[valueEnd - 1] === " " || head[valueEnd - 1] === "\t")) valueEnd--;
        const lower = head.substring(pos, colon).toLowerCase();
        const value = head.substring(valueStart, valueEnd);
        const index = names.indexOf(lower);
        if (index < 0) {
          names.push(lower);
          values.push(value);
        } else {
          values[index] = values[index] + (lower === "cookie" ? "; " : ", ") + value;
        }
      }
      pos = eol + 2;
    }
    return headers;
  }

  // Every entry as "name: value\r\n", for an adapter writing a response head
  // in one string rather than through a per-entry callback.
  // Static for the re-parenting reason given on the fields above: an instance
  // method reading the arrays would refuse `RequestHeaders`' re-parenting, and
  // going through `entries()` instead costs the response hot path a generator.
  static wireLinesOf(headers: Headers): string {
    const names = headers.headerNames;
    const values = headers.headerValues;
    if (names === undefined || values === undefined) return "";
    let lines = "";
    for (let i = 0; i < names.length; i++) lines += names[i] + ": " + values[i] + "\r\n";
    return lines;
  }

  get(name: string): string | null {
    const names = this.headerNames;
    const values = this.headerValues;
    if (names === undefined || values === undefined) return null;
    const lower = name.toLowerCase();
    for (let i = 0; i < names.length; i++) {
      if (names[i] === lower) return values[i];
    }
    return null;
  }

  set(name: string, value: string): void {
    const lower = name.toLowerCase();
    let names = this.headerNames;
    let values = this.headerValues;
    if (names === undefined || values === undefined) {
      names = [];
      values = [];
      this.headerNames = names;
      this.headerValues = values;
    }
    for (let i = 0; i < names.length; i++) {
      if (names[i] === lower) {
        values[i] = value;
        return;
      }
    }
    names.push(lower);
    values.push(value);
  }

  append(name: string, value: string): void {
    // node-compat: single-valued (sufficient for the common response headers).
    this.set(name, value);
  }

  has(name: string): boolean {
    return this.get(name) !== null;
  }

  delete(name: string): void {
    const oldNames = this.headerNames;
    const oldValues = this.headerValues;
    if (oldNames === undefined || oldValues === undefined) return;
    const lower = name.toLowerCase();
    const names: string[] = [];
    const values: string[] = [];
    for (let i = 0; i < oldNames.length; i++) {
      if (oldNames[i] === lower) continue;
      names.push(oldNames[i]);
      values.push(oldValues[i]);
    }
    this.headerNames = names;
    this.headerValues = values;
  }

  forEach(callback: (value: string, key: string) => void): void {
    const names = this.headerNames;
    const values = this.headerValues;
    if (names === undefined || values === undefined) return;
    for (let i = 0; i < names.length; i++) callback(values[i], names[i]);
  }

  // WHATWG iteration surface (hono's `set res` merges headers via
  // `.entries()` and preserves cookies via `.getSetCookie()`).
  //
  // The overload-plus-generator shape mirrors `URLSearchParams`'s own
  // `keys`/`values`/`entries`, further down this file (see that class for
  // the full rationale): the PUBLIC signature states the wider
  // `HeadersIterator<T>` callers expect -- `@hono/node-server`'s own
  // `headers.ts` declares its own `keys()`/`values()`/`entries()` against
  // exactly that name, delegating straight to these methods -- while the
  // IMPLEMENTATION signature stays the literal `Generator<T>` geatsc
  // maps to its native `iterator` cursor kind (see `[Symbol.iterator]`'s own
  // comment, below, for the two traps that shape depends on). A plain
  // `[string,string][]` return here used to satisfy nothing but this file's
  // own callers; `RequestHeaders#entries()`'s delegation surfaced the gap
  // ("Type '[string, string][]' is missing ... Generator").
  entries(): HeadersIterator<[string, string]>;
  *entries(): Generator<[string, string]> {
    const names = this.headerNames;
    const values = this.headerValues;
    if (names === undefined || values === undefined) return;
    for (let i = 0; i < names.length; i++) yield [names[i], values[i]];
  }

  keys(): HeadersIterator<string>;
  *keys(): Generator<string> {
    const names = this.headerNames;
    if (names === undefined) return;
    for (let i = 0; i < names.length; i++) yield names[i];
  }

  values(): HeadersIterator<string>;
  *values(): Generator<string> {
    const values = this.headerValues;
    if (values === undefined) return;
    for (let i = 0; i < values.length; i++) yield values[i];
  }

  // hono's `set res` and `#newResponse` both do `for (const [k, v] of headers)`
  // directly on a Headers instance (context.ts), which needs Headers itself to
  // be iterable — not just `.entries()`.
  //
  // A GENERATOR method, not `entries()[Symbol.iterator]()` returning a plain
  // `ArrayIterator` (this method's own prior shape, kept for a long time
  // because of two now-fixed compiler defects -- see below). Two traps,
  // each cost an iteration to find, both load-bearing for anyone touching
  // this again:
  //
  // - The return annotation must be `Generator<[string, string]>`, never the
  //   wider `IterableIterator<[string, string]>`. Only the literal ambient
  //   `Generator<T, TReturn, TNext>` maps to geatsc's native `iterator`
  //   cursor kind (`representation/derive.ts`'s `GeneratorDeclarationPolicy`,
  //   deliberately scoped to that one declaration and not to
  //   `IterableIterator`/`Iterator` -- see that policy's own comment for why).
  //   Annotate `IterableIterator` here and the method typechecks identically
  //   but compiles to the wrong carrier.
  // - The body must be a plain `for...of` + `yield`, never `yield* this.
  //   entries()`. `yield*` over an array hits an unrelated compiler root
  //   error ("no loop to build one in") that a `for...of` body does not.
  //
  // This rewrite was tried once before and reverted: it exposed two real
  // compiler defects rather than working around them cleanly --
  // `CallableObject<ReturnType()>` built with no receiver slot then called
  // with one (fixed by compiler commit `0e1281e16`), and the general iterator
  // protocol's synthetic `{ next(): {value,done} }` record disagreeing with a
  // real `Generator<T>`'s native `gea::Iterator<T>` carrier (fixed by
  // compiler commit `0575b66a5`). Both are fixed now, which is what makes
  // this rewrite land clean instead of refusing at emission.
  //
  // The PRIOR defect this method used to route around with `ArrayIterator`
  // (rather than the wider `IterableIterator`) was a different one: a
  // structural-type-interning order-sensitivity bug in `structural.ts`'s
  // anchor/complete/abandon lifecycle, re-verified fixed and unrelated to
  // this rewrite -- kept here as a pointer in case a shape-interning symptom
  // (two ids for what should be one shape) ever resurfaces on THIS method
  // again, so it is not re-diagnosed from scratch.
  *[Symbol.iterator](): Generator<[string, string]> {
    for (const entry of this.entries()) yield entry;
  }

  getSetCookie(): string[] {
    // node-compat Headers is single-valued per name (append == set), so at
    // most one set-cookie entry exists.
    const value = this.get("set-cookie");
    return value === null ? [] : [value];
  }
}

type Headers = HeadersImpl;
var Headers: typeof HeadersImpl = HeadersImpl;

// Same split as `Headers` above, for the same reason: `@hono/node-server`'s
// `response.ts` reads `global.Response` at module load.
class ResponseImpl {
  // Every WHATWG `Response` attribute is a prototype ACCESSOR over private
  // state, as on the platform. `@hono/node-server` re-parents its lightweight
  // `Response` onto this class (`Object.setPrototypeOf(Response.prototype,
  // GlobalResponse.prototype)`) and answers every one of these itself; its
  // instances never run this constructor, so a public data field here would
  // be state a lightweight instance claims to have and does not. The compiler
  // admits that re-parenting only when the base's public surface is behaviour
  // (`semantics/prototype-reparenting.ts`).
  private status_: number = 200;
  private statusText_: string = "";
  private headers_: Headers = new Headers();
  // The whole body, buffered eagerly: `text()` and `json()` are synchronous
  // here, a deliberate simplification rather than spec fidelity.
  private bodyText_: string = "";
  get status(): number {
    return this.status_;
  }
  get statusText(): string {
    return this.statusText_;
  }
  get headers(): Headers {
    return this.headers_;
  }
  get ok(): boolean {
    return this.status_ >= 200 && this.status_ < 300;
  }
  // No live stream exists (see `bodyText_`); WHATWG allows `null` for a
  // response without a body stream, and apps only test for the property.
  get body(): ReadableStream<Uint8Array> | null {
    return null;
  }
  // The rest of the WHATWG surface hono's `ClientResponse<T>` requires.
  get bodyUsed(): boolean {
    return false;
  }
  get redirected(): boolean {
    return false;
  }
  get type(): "basic" | "cors" | "default" | "error" | "opaque" | "opaqueredirect" {
    return "default";
  }
  get url(): string {
    return "";
  }
  // Node's `Response` has no trailers; `@hono/node-server` still forwards
  // the name, and a read answers what the platform's does.
  get trailers(): undefined {
    return undefined;
  }
  // Not WHATWG: the body as this shim already holds it, for an adapter that
  // writes it to the wire without the `await response.text()` round trip (a
  // Promise, a job, and a continuation per response, for a string that is
  // sitting right here).
  // Static, not an accessor: `@hono/node-server`'s lightweight Response is
  // re-parented onto this class, and the compiler admits that only while every
  // inherited instance member reaches `this` solely to look up a method (see
  // semantics/prototype-reparenting.ts). An instance getter reading a field
  // that the lightweight class does not override would refuse the whole
  // re-parenting; a static reader is outside that rule. The native adapter
  // (hono-node-server.ts) is the only caller, and never sees a re-parented
  // instance.
  static bodyTextOf(response: Response): string {
    return response.bodyText_;
  }

  // Keep Hono's concrete response-data union. An `any` parameter forced the
  // parameter census to reconstruct it from indirect constructor calls. That
  // lost the string/ArrayBuffer arms and made a string response read the
  // ReadableStream arm in generated C++. Stating the actual reachable
  // contract once keeps every arm native. `init` likewise stays a typed
  // record.
  constructor(body: BodyInit | undefined = null, init?: ResponseInit) {
    if (typeof body === "string") {
      this.bodyText_ = body;
    } else if (body === null || body === undefined) {
      this.bodyText_ = "";
    } else if (body instanceof ReadableStream) {
      throw new TypeError(
        "ReadableStream response bodies are not implemented in node-compat",
      );
    } else if (ArrayBuffer.isView(body)) {
      // Every view, not only `Uint8Array`: `BodyInit` admits any
      // `ArrayBufferView`, and this reads the underlying bytes through
      // `byteOffset`/`byteLength`, which every view has.
      const view = body as ArrayBufferView<ArrayBuffer>;
      this.bodyText_ = Buffer.from(
        view.buffer,
        view.byteOffset,
        view.byteLength,
      ).toString("latin1");
    } else if (body instanceof ArrayBuffer) {
      this.bodyText_ = Buffer.from(body).toString("latin1");
    } else if (body instanceof URLSearchParams) {
      // WHATWG Fetch §6: a `URLSearchParams` body IS its serialization, with
      // `application/x-www-form-urlencoded;charset=UTF-8` as the media type
      // the class supplies (set below, only if the caller named none).
      this.bodyText_ = body.toString();
    } else if (body instanceof FormData) {
      // Refused rather than approximated: a `FormData` body is `multipart/
      // form-data` with a generated boundary, and a `Response` whose body was
      // silently serialized some other way is a wrong answer on the wire, not
      // a missing feature the caller can see.
      throw new TypeError(
        "FormData response bodies are not implemented in node-compat",
      );
    } else {
      // `Blob`. Its bytes exist synchronously (a `Buffer` field) but only
      // `arrayBuffer()`/`bytes()`/`text()` expose them, and all three are
      // async -- a constructor cannot await. Refused, not guessed.
      throw new TypeError(
        "Blob response bodies are not implemented in node-compat",
      );
    }
    if (init !== undefined && init !== null) {
      // NaN check: a typed `{ status?: number }` record crossing the dynamic
      // boundary carries `undefined` as NaN (the runtime's numeric null
      // sentinel) — treat it as absent, per WHATWG "status not provided".
      const initStatus = Number(init.status);
      if (
        init.status !== undefined &&
        init.status !== null &&
        initStatus === initStatus
      )
        this.status_ = initStatus;
      if (init.statusText !== undefined)
        this.statusText_ = String(init.statusText);
      if (init.headers !== undefined && init.headers !== null) {
        const h = init.headers;
        if (h instanceof Headers) {
          this.headers_.copyFrom(h);
        } else if (Array.isArray(h)) {
          for (const pair of h) this.headers_.set(pair[0], pair[1]);
        } else {
          for (const key in h)
            this.headers_.set(key, String((h as Record<string, string>)[key]));
        }
      }
    }
    // String body extraction supplies a media type only when the caller did
    // not set one. Hono's text fast path relies on new Response(text) doing
    // this; otherwise the HTTP adapter silently substitutes its own header.
    // Spelled the way `@hono/node-server`'s own Response spells it
    // (`defaultContentType = "text/plain; charset=UTF-8"`, with the space),
    // not WHATWG's `text/plain;charset=UTF-8`: this shim stands where that
    // package's Response replacement stood on Node, and the wire a Hono app
    // produced there is the reference its compiled build is checked against.
    if (typeof body === "string" && !this.headers_.has("content-type")) {
      this.headers_.set("content-type", "text/plain; charset=UTF-8");
    }
    if (body instanceof URLSearchParams && !this.headers_.has("content-type")) {
      this.headers_.set(
        "content-type",
        "application/x-www-form-urlencoded;charset=UTF-8",
      );
    }
  }

  // Return type is `string | Promise<string>`, not WHATWG's `Promise<string>`
  // — a TYPE-LEVEL widening only, with no runtime effect on this class's own
  // callers: this method still just returns the plain string it always did
  // (`await` unwraps a non-Promise value exactly like a resolved one, so
  // `apps/hono-hello/server.ts`'s `await response.text()` is unaffected
  // either way). It exists because hono's own `client/utils.ts`
  // (`parseResponse<T extends ClientResponse<any>>`) requires a `T` — whose
  // `text()` returns a REAL `Promise<string>`, per `ClientResponse`'s own
  // interface — to be assignable to this class; `Promise<string>` is
  // assignable to `string | Promise<string>` but not to bare `string`. This
  // makes the check pass without making `text()` genuinely asynchronous,
  // which would put real Promise machinery on the hot path (every hono-hello
  // request calls this) for a code path (`hono/client`) nothing here calls.
  text(): string | Promise<string> {
    return this.bodyText_;
  }
  // `json`/`arrayBuffer`/`blob`/`formData` complete the WHATWG `Body`
  // mixin's member set (hono's own `request.ts` indexes `Body` generically
  // by key — `raw[key]()` — so all five names must exist), but nothing this
  // target builds calls a Response's through any of these four: hono-hello
  // only ever reads `.text()` on a Response, and a grep of every real app
  // entry plus hono's own non-test source found zero callers of
  // `Response#json()` anywhere reachable (contrast `Request#json()` below,
  // which `apps/hono-mongodb-todo/server.ts:89,108` genuinely awaits — that
  // one stays a real `JSON.parse`). Honest stubs (all four throw — matching
  // `Blob`'s own unimplemented methods above, rather than fabricated
  // behavior), with the same `T | Promise<T>` return-type widening `text()`
  // has, and for the identical reason: `ClientResponse`'s versions genuinely
  // return Promises.
  json(): unknown | Promise<unknown> {
    throw new Error("Response.json is not implemented in node-compat");
  }
  arrayBuffer(): ArrayBuffer | Promise<ArrayBuffer> {
    throw new Error("Response.arrayBuffer is not implemented in node-compat");
  }
  blob(): Blob | Promise<Blob> {
    throw new Error("Response.blob is not implemented in node-compat");
  }
  // Unlike `text()`/`json()`/`arrayBuffer()`/`blob()` above, this one is not
  // widened to `T | Promise<T>`: WHATWG's `Body#formData()` is declared
  // `Promise<FormData>` with no synchronous variant anywhere in the spec (and
  // so is Node's own `.d.ts`), so a bare `FormData` return here is not a
  // narrower honest answer, it is the wrong type. `@hono/node-server`'s
  // `utils/buffer.ts` awaits `response.formData()` expecting exactly
  // `Promise<FormData>` and fails to typecheck against the widened union.
  // The stub still throws synchronously -- `throw` is assignable to any
  // return type -- so this is a declaration fix, not a behavior change.
  formData(): Promise<FormData> {
    throw new Error("Response.formData is not implemented in node-compat");
  }
  bytes(): Promise<Uint8Array> {
    throw new Error("Response.bytes is not implemented in node-compat");
  }
  // WHATWG's `Response.redirect(url, status)` is a STATIC factory (it is on
  // `interface ResponseConstructor`, not `interface Response`, in
  // `lib.dom.d.ts`), not an instance method — deliberately NOT added as one
  // here, and not needed by anything this target builds (`c.redirect()`,
  // hono's own OWN, unrelated, `Context` method, builds a `Response` via the
  // constructor instead). An instance method of this name would additionally
  // collide with `RequestInit.redirect: string`, a genuinely different
  // field, wherever hono's own source structurally compares the two (e.g.
  // `context.ts`'s `body: BodyRespond = (data, arg: StatusCode | RequestInit,
  // ...)`, itself typed against the wrong interface — hono's own upstream
  // code names `RequestInit` where `ResponseOrInit` was clearly meant, and
  // only compiles today because DOM's real `Response` has no instance
  // `redirect` to collide with either).
  clone(): Response {
    const r = new Response(this.bodyText_, {
      status: this.status_,
      statusText: this.statusText_,
    });
    this.headers_.forEach((value, name) => r.headers.set(name, value));
    return r;
  }
}

type Response = ResponseImpl;
var Response: typeof ResponseImpl = ResponseImpl;

interface ResponseInit {
  status?: number;
  statusText?: string;
  // WHATWG `HeadersInit` (`Headers | string[][] | Record<string, string>`): a
  // Headers INSTANCE is a legal value (hono passes the merged
  // `responseHeaders` object straight through). A bare `Record<string,
  // string>` annotation lowered this field to a typed str_map slot, and
  // coercing a Headers instance into it produced an EMPTY map — the response
  // silently lost every header. The union keeps the slot dynamic so all
  // three shapes cross intact; the Response constructor duck-types which one
  // arrived. The array-of-pairs arm also matters for a reason that has
  // nothing to do with node-compat's own construction: hono's own
  // `body: BodyRespond = (data, arg: StatusCode | RequestInit, ...)`
  // (`context.ts`) is typed against the WRONG interface (`RequestInit`
  // instead of `ResponseOrInit`) and only compiles because `RequestInit`'s
  // `headers` is structurally wide enough to accept `ResponseHeadersInit`,
  // which includes `[string, string][]` — dropping that arm here breaks
  // hono's own (upstream, source-level) code, not anything of ours.
  headers?: Record<string, string> | Headers | [string, string][];
}

// A module function rather than a Request method: every body reader is
// overridden by node-server's lightweight request, and a helper it does not
// override would be inherited state access (see the readers below).
async function drainRequestBody(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    const chunk = result.value;
    chunks.push(Buffer.from(chunk.buffer as ArrayBuffer, chunk.byteOffset, chunk.byteLength));
  }
  return Buffer.concat(chunks);
}

// Same split as `Headers`/`Response` above, for the same reason: `request.ts`
// reads `global.Request` at module load.
class RequestImpl {
  // Every WHATWG member is an accessor over private storage, as on a real
  // `Request`: `@hono/node-server` re-parents its lightweight request onto
  // this class without running this constructor, which the compiler models
  // only when nothing the subclass inherits reads instance state (see
  // `prototype-reparenting.ts`). A public field is state; a getter the
  // subclass overrides is not.
  private url_: string;
  get url(): string {
    return this.url_;
  }
  private method_: string = "GET";
  get method(): string {
    return this.method_;
  }
  // `headers`, `bodyUsed`, `body` and `signal` are ACCESSORS rather than data
  // fields, unlike every other member here, because `@hono/node-server`'s
  // lightweight request overrides all four — and a data property cannot be
  // overridden by a getter (TS2610). The platform agrees: on a real WHATWG
  // `Request` every one of these is a prototype accessor, so this is the more
  // faithful shape as well as the one a subclass can lazily compute.
  //
  // The backing store is created on first read, not at construction: the
  // lightweight request never reads the base's own `headers`, and allocating
  // one per request to have it thrown away is the cost the whole lazy request
  // path exists to avoid.
  private headers_: Headers | undefined;
  // The wire header block a `fromWire` request was built from, parsed into
  // `headers_` on the first read (see `HeadersImpl.fromRawHead`). No
  // initializer, like `headers_` above: an initialized field is instance
  // state the re-parented lightweight request would inherit, and
  // `prototype-reparenting.ts` models the re-parenting only when it inherits
  // none.
  private rawHead_: string | undefined;
  get headers(): Headers {
    let headers = this.headers_;
    if (headers === undefined) {
      headers = this.rawHead_ === undefined ? new Headers() : Headers.fromRawHead(this.rawHead_);
      this.headers_ = headers;
    }
    return headers;
  }
  set headers(value: Headers) {
    this.headers_ = value;
  }

  // Not WHATWG: a request straight from the reactor's dispatch, for the
  // native `@hono/node-server` answer (`hono-node-server.ts`). Nothing is
  // parsed or copied here beyond what is handed in: the URL is already
  // complete, the method is the wire token, the header block waits for a
  // read, and the body is the reactor's own bytes.
  static fromWire(url: string, method: string, rawHead: string, body: Buffer | undefined): Request {
    const request = new RequestImpl(url);
    request.method_ = method;
    request.rawHead_ = rawHead;
    request.bodyBytes_ = body;
    return request;
  }
  // HTTP request bodies arrive as bytes. Keep those bytes in Buffer's native
  // Uint8Array-backed carrier so text/JSON decoding and multipart file parts
  // share one source without copying through a boxed value.
  private bodyBytes_: Buffer | undefined;

  // Full DOM RequestInit surface as typed fields. hono's typed code reads
  // these off the request; folding the ambient DOM `Request` type to this
  // shim turns a harmless boxed `undefined` read into a compile error on a
  // missing member. Defaults are the WHATWG spec initial values; none are
  // load-bearing on the server request path.
  get cache(): string {
    return "default";
  }
  get credentials(): string {
    return "same-origin";
  }
  get destination(): string {
    return "";
  }
  get integrity(): string {
    return "";
  }
  get keepalive(): boolean {
    return false;
  }
  get mode(): string {
    return "cors";
  }
  get redirect(): string {
    return "follow";
  }
  get referrer(): string {
    return "about:client";
  }
  get referrerPolicy(): string {
    return "";
  }
  private bodyUsed_: boolean = false;
  get bodyUsed(): boolean {
    return this.bodyUsed_;
  }
  set bodyUsed(value: boolean) {
    this.bodyUsed_ = value;
  }
  private body_: ReadableStream<Uint8Array> | null = null;
  get body(): ReadableStream<Uint8Array> | null {
    return this.body_;
  }
  set body(value: ReadableStream<Uint8Array> | null) {
    this.body_ = value;
  }
  // `AbortSignal` is declared further down (honest, unimplemented — see its
  // declaration). `null` by default rather than `new AbortSignal()`: this
  // field is read only by `request.ts`'s `cloneRawRequest`, never called by
  // anything this target builds, and constructing one on every `new
  // Request()` would put an unresolved external on the REQUEST HOT PATH
  // instead of behind the unreached call.
  private signal_: AbortSignal | null = null;
  get signal(): AbortSignal | null {
    return this.signal_;
  }
  set signal(value: AbortSignal | null) {
    this.signal_ = value;
  }

  // `init` typed as the RequestInit record keeps the per-request
  // `new Request(url, { method })` bridge in server code fully native (the
  // literal lowers to the typed record instead of a boxed object).
  // `input` is WHATWG's `RequestInfo`: a URL string, a `URL`, or a `Request`
  // to copy from. Stated as the three it can be rather than left open --
  // geatsc reads a method call on an opaquely-typed receiver as a possible
  // host-global mutation and stamps a wildcard over the whole host surface,
  // which refuses every `Buffer.*` read in this very file.
  constructor(input: string | URL | Request, init?: RequestInit) {
    this.url_ = String(input);
    if (init !== undefined && init !== null) {
      if (init.method !== undefined) this.method_ = String(init.method);
      if (init.headers !== undefined && init.headers !== null) {
        const h = init.headers;
        if (h instanceof Headers) {
          this.headers.copyFrom(h);
        } else if (Array.isArray(h)) {
          for (const pair of h) this.headers.set(pair[0], pair[1]);
        } else {
          for (const key in h)
            this.headers.set(key, String((h as Record<string, string>)[key]));
        }
      }
      // Ordinary string bodies follow Fetch's UTF-8 encoding. Native HTTP
      // adapters wrap the reactor's byte-preserving string in a Buffer before
      // constructing Request, which reaches the ArrayBufferView arm below.
      if (typeof init.body === "string") {
        this.bodyBytes_ = Buffer.from(init.body, "utf8");
      } else if (init.body instanceof URLSearchParams) {
        this.bodyBytes_ = Buffer.from(init.body.toString(), "utf8");
        if (!this.headers.has("content-type")) {
          this.headers.set(
            "content-type",
            "application/x-www-form-urlencoded;charset=UTF-8",
          );
        }
      } else if (init.body instanceof Blob) {
        this.bodyBytes_ = Buffer.from(init.body.bytesString(), "latin1");
        if (init.body.type.length > 0 && !this.headers.has("content-type")) {
          this.headers.set("content-type", init.body.type);
        }
      } else if (init.body instanceof FormData) {
        const encoded = init.body.encodeMultipart();
        this.bodyBytes_ = Buffer.from(encoded.body, "latin1");
        if (!this.headers.has("content-type")) {
          this.headers.set(
            "content-type",
            "multipart/form-data; boundary=" + encoded.boundary,
          );
        }
      } else if (
        init.body !== undefined &&
        init.body !== null &&
        ArrayBuffer.isView(init.body)
      ) {
        const buffer = init.body.buffer as ArrayBuffer;
        this.bodyBytes_ = Buffer.from(
          buffer,
          init.body.byteOffset,
          init.body.byteLength,
        );
      } else if (init.body instanceof ReadableStream) {
        // @hono/node-server hands the socket to `Readable.toWeb` whenever the
        // body is not read on its fast path (multipart forms among them); the
        // readers below drain it on first use.
        this.body_ = init.body;
      } else if (init.body !== undefined && init.body !== null) {
        this.bodyBytes_ = Buffer.from(init.body as ArrayBuffer);
      }
    }
  }

  // Each body reader consumes inline rather than through a shared private
  // helper: every reader is overridden by the lightweight request, and a
  // helper it does not override would be inherited state access.
  async text(): Promise<string> {
    if (this.bodyUsed_) throw new TypeError("Body is unusable");
    this.bodyUsed_ = true;
    const bytes = this.body_ !== null ? await drainRequestBody(this.body_) : (this.bodyBytes_ ?? Buffer.alloc(0));
    return bytes.toString("utf8");
  }

  async json(): Promise<unknown> {
    if (this.bodyUsed_) throw new TypeError("Body is unusable");
    this.bodyUsed_ = true;
    const bytes = this.body_ !== null ? await drainRequestBody(this.body_) : (this.bodyBytes_ ?? Buffer.alloc(0));
    return JSON.parse(bytes.toString("utf8"));
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    if (this.bodyUsed_) throw new TypeError("Body is unusable");
    this.bodyUsed_ = true;
    const bytes = this.body_ !== null ? await drainRequestBody(this.body_) : (this.bodyBytes_ ?? Buffer.alloc(0));
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
  }

  async blob(): Promise<Blob> {
    const type = this.headers.get("content-type") ?? "";
    if (this.bodyUsed_) throw new TypeError("Body is unusable");
    this.bodyUsed_ = true;
    const bytes = this.body_ !== null ? await drainRequestBody(this.body_) : (this.bodyBytes_ ?? Buffer.alloc(0));
    return new Blob([bytes], { type });
  }

  async formData(): Promise<FormData> {
    const contentType = this.headers.get("content-type") ?? "";
    if (this.bodyUsed_) throw new TypeError("Body is unusable");
    this.bodyUsed_ = true;
    const bytes = this.body_ !== null ? await drainRequestBody(this.body_) : (this.bodyBytes_ ?? Buffer.alloc(0));
    if (
      contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")
    ) {
      const result = new FormData();
      const params = new URLSearchParams(bytes.toString("utf8"));
      params.forEach((value, name) => result.append(name, value));
      return result;
    }
    if (contentType.toLowerCase().startsWith("multipart/form-data")) {
      return FormData.parseMultipart(bytes.toString("latin1"), contentType);
    }
    throw new TypeError("Request.formData requires a form content-type");
  }

  clone(): Request {
    if (this.bodyUsed) throw new TypeError("Body is unusable");
    const r = new Request(this.url, {
      method: this.method,
      body: this.bodyBytes_ ?? Buffer.alloc(0),
    });
    this.headers.forEach((value, name) => r.headers.set(name, value));
    return r;
  }
}

type Request = RequestImpl;
var Request: typeof RequestImpl = RequestImpl;

interface RequestInit {
  method?: string;
  // Same duck-typed `HeadersInit` union as `ResponseInit.headers`, and the
  // same two reasons — see that field's comment.
  headers?: Record<string, string> | Headers | [string, string][];
  // WHATWG `BodyInit` (declared above `URL`), not `string`: hono's own
  // `cloneRawRequest` assigns `await req[cacheKey]()` here, which is
  // `string | ArrayBuffer | Blob | FormData` depending which body accessor
  // was cached first.
  body?: BodyInit | null;
  // `window` (deprecated in the Fetch spec, always `null`) and `priority`
  // exist ONLY so hono's own `RequiredRequestInit = Required<Omit<RequestInit,
  // 'window' | 'priority'>> & {...}` (`request.ts`) can index `RequestInit['window'
  // | 'priority']` — a mapped type's indexed access fails to resolve if the
  // key is absent from the type entirely, even optionally. Never read by
  // node-compat itself.
  window?: null;
  priority?: "auto" | "low" | "high";
  signal?: AbortSignal | null;
  // The rest of the WHATWG `RequestInit` surface, matching `Request`'s own
  // fields of the same names 1:1 (see that class) — needed because hono's
  // `request.ts`'s `cloneRawRequest` builds a `RequiredRequestInit` object
  // literal that assigns all of `Request`'s fields straight back through
  // this interface. Never read by node-compat's own construction (the
  // `Request` constructor only consults `method`/`headers`/`body`, above).
  cache?: string;
  credentials?: string;
  integrity?: string;
  keepalive?: boolean;
  mode?: string;
  redirect?: string;
  referrer?: string;
  referrerPolicy?: string;
}

class URLSearchParams {
  private paramNames: string[] = [];
  private paramValues: string[] = [];

  constructor(query: string = "") {
    let q = query;
    if (q.length > 0 && q[0] === "?") q = q.slice(1);
    if (q.length === 0) return;
    const parts = q.split("&");
    for (const part of parts) {
      if (part.length === 0) continue;
      const eq = part.indexOf("=");
      if (eq < 0) {
        this.paramNames.push(this.decode(part));
        this.paramValues.push("");
      } else {
        this.paramNames.push(this.decode(part.slice(0, eq)));
        this.paramValues.push(this.decode(part.slice(eq + 1)));
      }
    }
  }

  private decode(value: string): string {
    // URLSearchParams uses application/x-www-form-urlencoded decoding, where
    // `+` represents a space before percent decoding.
    return decodeURIComponent(value.split("+").join(" "));
  }

  private encode(value: string): string {
    // encodeURIComponent's allow-list is slightly wider than the form-url
    // encoder used by URLSearchParams. Keep `*`, but escape the extra five
    // printable characters and serialize spaces as `+`.
    return encodeURIComponent(value)
      .split("%20")
      .join("+")
      .split("!")
      .join("%21")
      .split("'")
      .join("%27")
      .split("(")
      .join("%28")
      .split(")")
      .join("%29")
      .split("~")
      .join("%7E");
  }

  append(name: string, value: string): void {
    this.paramNames.push(name);
    this.paramValues.push(value);
  }

  delete(name: string): void {
    for (let i = this.paramNames.length - 1; i >= 0; i--) {
      if (this.paramNames[i] !== name) continue;
      this.paramNames.splice(i, 1);
      this.paramValues.splice(i, 1);
    }
  }

  get(name: string): string | null {
    for (let i = 0; i < this.paramNames.length; i++) {
      if (this.paramNames[i] === name) return this.paramValues[i];
    }
    return null;
  }

  getAll(name: string): string[] {
    const values: string[] = [];
    for (let i = 0; i < this.paramNames.length; i++) {
      if (this.paramNames[i] === name) values.push(this.paramValues[i]);
    }
    return values;
  }

  has(name: string): boolean {
    for (let i = 0; i < this.paramNames.length; i++) {
      if (this.paramNames[i] === name) return true;
    }
    return false;
  }

  set(name: string, value: string): void {
    let first = -1;
    for (let i = 0; i < this.paramNames.length; i++) {
      if (this.paramNames[i] !== name) continue;
      if (first < 0) {
        first = i;
        this.paramValues[i] = value;
      }
    }
    if (first < 0) {
      this.append(name, value);
      return;
    }

    // `set` preserves the first matching entry's position and removes later
    // duplicate entries.
    for (let i = this.paramNames.length - 1; i > first; i--) {
      if (this.paramNames[i] !== name) continue;
      this.paramNames.splice(i, 1);
      this.paramValues.splice(i, 1);
    }
  }

  forEach(callback: (value: string, key: string) => void): void {
    for (let i = 0; i < this.paramNames.length; i++) {
      callback(this.paramValues[i], this.paramNames[i]);
    }
  }

  keys(): IterableIterator<string>;
  *keys(): Generator<string> {
    for (let i = 0; i < this.paramNames.length; i++) yield this.paramNames[i];
  }

  values(): IterableIterator<string>;
  *values(): Generator<string> {
    for (let i = 0; i < this.paramValues.length; i++) yield this.paramValues[i];
  }

  entries(): IterableIterator<[string, string]>;
  *entries(): Generator<[string, string]> {
    for (let i = 0; i < this.paramNames.length; i++) {
      yield [this.paramNames[i], this.paramValues[i]];
    }
  }

  // URL Standard's iterators are live: a later append is visible to a cursor
  // already in flight. Returning a copied array loses both .next() and liveness.
  [Symbol.iterator](): IterableIterator<[string, string]>;
  *[Symbol.iterator](): Generator<[string, string]> {
    for (let i = 0; i < this.paramNames.length; i++) {
      yield [this.paramNames[i], this.paramValues[i]];
    }
  }

  toString(): string {
    const parts: string[] = [];
    for (let i = 0; i < this.paramNames.length; i++) {
      parts.push(
        this.encode(this.paramNames[i]) +
          "=" +
          this.encode(this.paramValues[i]),
      );
    }
    return parts.join("&");
  }
}

class URL {
  private hostnameValue: string = "";
  private portValue: string = "";
  private usernameValue: string = "";
  private passwordValue: string = "";

  protocol: string = "";
  pathname: string = "/";
  hash: string = "";
  searchParams: URLSearchParams = new URLSearchParams();

  constructor(url: string | URL, base: string | URL = "") {
    const urlText = typeof url === "string" ? url : url.href;
    const baseText = typeof base === "string" ? base : base.href;
    let full = urlText;
    if (baseText.length > 0 && urlText.indexOf("://") < 0)
      full = baseText + urlText;
    this.parse(full);
  }

  private parse(full: string): void {
    // Minimal parse: scheme://host[:port]/path?search#hash
    this.protocol = "";
    this.hostnameValue = "";
    this.portValue = "";
    this.usernameValue = "";
    this.passwordValue = "";
    this.pathname = "/";
    this.hash = "";

    let rest = full;
    const scheme = rest.indexOf("://");
    if (scheme >= 0) {
      this.protocol = rest.slice(0, scheme).toLowerCase() + ":";
      rest = rest.slice(scheme + 3);
    }
    const hashIndex = rest.indexOf("#");
    if (hashIndex >= 0) {
      this.hash = rest.slice(hashIndex);
      rest = rest.slice(0, hashIndex);
    }
    const queryIndex = rest.indexOf("?");
    let query = "";
    if (queryIndex >= 0) {
      query = rest.slice(queryIndex);
      rest = rest.slice(0, queryIndex);
    }
    const slash = rest.indexOf("/");
    let authority = rest;
    if (slash >= 0) {
      authority = rest.slice(0, slash);
      this.pathname = rest.slice(slash);
    }

    const at = authority.lastIndexOf("@");
    if (at >= 0) {
      const userInfo = authority.slice(0, at);
      authority = authority.slice(at + 1);
      const colon = userInfo.indexOf(":");
      if (colon >= 0) {
        this.usernameValue = userInfo.slice(0, colon);
        this.passwordValue = userInfo.slice(colon + 1);
      } else {
        this.usernameValue = userInfo;
      }
    }

    this.parseHost(authority);
    this.searchParams = new URLSearchParams(query);
  }

  private parseHost(value: string): void {
    this.hostnameValue = "";
    this.portValue = "";
    if (value.length === 0) return;

    // Keep brackets as part of an IPv6 hostname, matching WHATWG URL's
    // `hostname`, and only treat a colon after the closing bracket as a port.
    if (value[0] === "[") {
      const bracket = value.indexOf("]");
      if (bracket >= 0) {
        this.hostnameValue = value.slice(0, bracket + 1);
        if (value.length > bracket + 1 && value[bracket + 1] === ":") {
          this.portValue = value.slice(bracket + 2);
        }
        return;
      }
    }

    const firstColon = value.indexOf(":");
    const lastColon = value.lastIndexOf(":");
    if (firstColon >= 0 && firstColon === lastColon) {
      this.hostnameValue = value.slice(0, firstColon);
      this.portValue = value.slice(firstColon + 1);
    } else {
      this.hostnameValue = value;
    }
  }

  private encodeUserInfo(value: string): string {
    return encodeURIComponent(value);
  }

  get href(): string {
    return this.toString();
  }
  set href(value: string) {
    this.parse(value);
  }

  get username(): string {
    return this.usernameValue;
  }
  set username(value: string) {
    this.usernameValue = this.encodeUserInfo(value);
  }

  get password(): string {
    return this.passwordValue;
  }
  set password(value: string) {
    this.passwordValue = this.encodeUserInfo(value);
  }

  get hostname(): string {
    return this.hostnameValue;
  }
  set hostname(value: string) {
    this.hostnameValue = value;
  }

  get port(): string {
    return this.portValue;
  }
  set port(value: string) {
    this.portValue = value;
  }

  get host(): string {
    return this.portValue.length > 0
      ? this.hostnameValue + ":" + this.portValue
      : this.hostnameValue;
  }
  set host(value: string) {
    this.parseHost(value);
  }

  get search(): string {
    const query = this.searchParams.toString();
    return query.length > 0 ? "?" + query : "";
  }
  set search(value: string) {
    this.searchParams = new URLSearchParams(value);
  }

  get origin(): string {
    if (
      this.protocol === "http:" ||
      this.protocol === "https:" ||
      this.protocol === "ws:" ||
      this.protocol === "wss:" ||
      this.protocol === "ftp:"
    ) {
      return this.protocol + "//" + this.host;
    }
    return "null";
  }

  toString(): string {
    let auth = "";
    if (this.usernameValue.length > 0 || this.passwordValue.length > 0) {
      auth = this.usernameValue;
      if (this.passwordValue.length > 0) auth += ":" + this.passwordValue;
      auth += "@";
    }
    return (
      this.protocol +
      "//" +
      auth +
      this.host +
      this.pathname +
      this.search +
      this.hash
    );
  }
}

class Blob {
  private data_: Buffer;
  readonly size: number;
  readonly type: string;

  constructor(
    // Node's Buffer is an ArrayBufferView, but keeping its concrete arm is
    // load-bearing for native lowering: it preserves the typed-array carrier
    // instead of first rebuilding the three-field structural
    // ArrayBufferView record and losing IsView identity.
    blobParts: (string | ArrayBuffer | ArrayBufferView<ArrayBuffer> | Buffer | Blob)[] = [],
    options: { type?: string; endings?: "transparent" | "native" } = {},
  ) {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    for (const part of blobParts) {
      let chunk: Buffer;
      if (part instanceof Blob)
        chunk = Buffer.from(part.bytesString(), "latin1");
      else if (typeof part === "string") chunk = Buffer.from(part, "utf8");
      else if (ArrayBuffer.isView(part))
        chunk = Buffer.from(part.buffer, part.byteOffset, part.byteLength);
      else chunk = Buffer.from(part);
      chunks.push(chunk);
      totalLength += chunk.byteLength;
    }
    this.data_ = Buffer.concat(chunks, totalLength);
    this.size = totalLength;
    this.type = normalizeBlobType(options.type ?? "");
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(
      this.data_.buffer.slice(
        this.data_.byteOffset,
        this.data_.byteOffset + this.data_.byteLength,
      ) as ArrayBuffer,
    );
  }

  bytes(): Promise<Uint8Array> {
    return Promise.resolve(Buffer.from(this.data_));
  }

  text(): Promise<string> {
    return Promise.resolve(this.data_.toString("utf8"));
  }

  slice(
    start: number = 0,
    end: number = this.size,
    contentType: string = "",
  ): Blob {
    const from =
      start < 0 ? Math.max(this.size + start, 0) : Math.min(start, this.size);
    const to =
      end < 0 ? Math.max(this.size + end, 0) : Math.min(end, this.size);
    return new Blob([this.data_.subarray(from, Math.max(from, to))], {
      type: contentType,
    });
  }

  /** Internal byte-preserving bridge shared by Request and FormData. */
  bytesString(): string {
    return this.data_.toString("latin1");
  }

  formDataFileName(): string {
    return "blob";
  }

  formDataLastModified(): number {
    return Date.now();
  }
}

class File extends Blob {
  readonly name: string;
  readonly lastModified: number;

  constructor(
    fileBits: (string | ArrayBuffer | ArrayBufferView<ArrayBuffer> | Buffer | Blob)[],
    fileName: string,
    options: {
      type?: string;
      lastModified?: number;
      endings?: "transparent" | "native";
    } = {},
  ) {
    super(fileBits, options);
    this.name = fileName.split("/").join(":");
    this.lastModified = options.lastModified ?? Date.now();
  }

  override formDataFileName(): string {
    return this.name;
  }

  override formDataLastModified(): number {
    return this.lastModified;
  }
}

function normalizeBlobType(type: string): string {
  for (let i = 0; i < type.length; i++) {
    const code = type.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return "";
  }
  return type.toLowerCase();
}

interface EncodedMultipart {
  boundary: string;
  body: string;
}

let geaFormDataBoundarySerial = 0;

// WHATWG XMLHttpRequest §5.6's `FormDataEntryValue` -- what `FormData.get`/
// `.getAll`/an iteration entry answers with. Referenced by hono's own
// `utils/body.ts` (`BodyDataValue`) and used by Request's native multipart
// parser above.
type FormDataEntryValue = string | File;

class FormData {
  private entryNames: string[] = [];
  private entryValues: FormDataEntryValue[] = [];

  // WHATWG declares `append`/`set`'s `value` as `string | Blob`, and that
  // width is load-bearing, not decoration: hono's own `client/client.ts`
  // (`form.append(k, v)`, inside its `fetch` request-building loop) types
  // its own value as `FormValue = string | Blob` (`hono/src/types.ts`), and
  // `hono/src/index.ts` re-exports client types from `./client`, so this
  // parameter is checked against a real `Blob`-typed value on every program
  // that imports anything from the `hono` package root -- which is every
  // app here, including ones with no multipart form of their own. A prior
  // version of this method narrowed `value` to plain `string` on the belief
  // that every call site passes a string; that belief was wrong (it came
  // from grepping observed runtime values, not the declared static type
  // `client.ts` checks against) and the narrowing broke that file's
  // typecheck for every hono app compiled `--from-source=hono` the moment
  // the file was actually exercised end-to-end, rather than in the isolated
  // globals-only probe that validated it.
  //
  // The real defect was never the parameter's width -- it was this body's
  // old `value instanceof Blob ? (value as File) : String(value)`, which
  // cast every `Blob` to `File` (`File extends Blob`, never the reverse).
  // `normalizeEntry` now performs the required byte-preserving conversion:
  // a Blob becomes a File, with an explicit filename when supplied and the
  // Blob's media type retained.
  append(name: string, value: string | Blob, fileName?: string): void {
    this.entryNames.push(name);
    this.entryValues.push(this.normalizeEntry(value, fileName));
  }

  delete(name: string): void {
    const names: string[] = [];
    const values: FormDataEntryValue[] = [];
    for (let i = 0; i < this.entryNames.length; i++) {
      if (this.entryNames[i] === name) continue;
      names.push(this.entryNames[i]);
      values.push(this.entryValues[i]);
    }
    this.entryNames = names;
    this.entryValues = values;
  }

  get(name: string): FormDataEntryValue | null {
    for (let i = 0; i < this.entryNames.length; i++) {
      if (this.entryNames[i] === name) return this.entryValues[i];
    }
    return null;
  }

  getAll(name: string): FormDataEntryValue[] {
    const out: FormDataEntryValue[] = [];
    for (let i = 0; i < this.entryNames.length; i++) {
      if (this.entryNames[i] === name) out.push(this.entryValues[i]);
    }
    return out;
  }

  has(name: string): boolean {
    for (let i = 0; i < this.entryNames.length; i++) {
      if (this.entryNames[i] === name) return true;
    }
    return false;
  }

  set(name: string, value: string | Blob, fileName?: string): void {
    const entry = this.normalizeEntry(value, fileName);
    let first = -1;
    for (let i = 0; i < this.entryNames.length; i++) {
      if (this.entryNames[i] !== name) continue;
      if (first < 0) {
        first = i;
        this.entryValues[i] = entry;
      }
    }
    if (first < 0) {
      this.entryNames.push(name);
      this.entryValues.push(entry);
      return;
    }
    for (let i = this.entryNames.length - 1; i > first; i--) {
      if (this.entryNames[i] !== name) continue;
      this.entryNames.splice(i, 1);
      this.entryValues.splice(i, 1);
    }
  }

  forEach(callback: (value: FormDataEntryValue, key: string) => void): void {
    for (let i = 0; i < this.entryNames.length; i++)
      callback(this.entryValues[i], this.entryNames[i]);
  }

  entries(): [string, FormDataEntryValue][] {
    const out: [string, FormDataEntryValue][] = [];
    for (let i = 0; i < this.entryNames.length; i++)
      out.push([this.entryNames[i], this.entryValues[i]]);
    return out;
  }

  keys(): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.entryNames.length; i++)
      out.push(this.entryNames[i]);
    return out;
  }

  values(): FormDataEntryValue[] {
    const out: FormDataEntryValue[] = [];
    for (let i = 0; i < this.entryValues.length; i++)
      out.push(this.entryValues[i]);
    return out;
  }

  // A generator method -- see `Headers[Symbol.iterator]` (this file) for the
  // full rationale and the two traps this shape depends on: `Generator<T>`,
  // never the wider `IterableIterator<T>` (only `Generator` maps to
  // geatsc's native `iterator` cursor), and a plain `for...of` + `yield`
  // body, never `yield*` (hits an unrelated compiler root error).
  *[Symbol.iterator](): Generator<[string, FormDataEntryValue]> {
    for (const entry of this.entries()) yield entry;
  }

  private normalizeEntry(
    value: string | Blob,
    fileName?: string,
  ): FormDataEntryValue {
    if (!(value instanceof Blob)) return value;
    return new File([value], fileName ?? value.formDataFileName(), {
      type: value.type,
      lastModified: value.formDataLastModified(),
    });
  }

  /** Encode this form using Fetch's multipart/form-data body shape. */
  encodeMultipart(): EncodedMultipart {
    geaFormDataBoundarySerial++;
    const boundary = "----gea-formdata-" + String(geaFormDataBoundarySerial);
    let body = "";
    for (let i = 0; i < this.entryNames.length; i++) {
      const name = escapeMultipartQuoted(this.entryNames[i]);
      const value = this.entryValues[i];
      body += "--" + boundary + "\r\n";
      if (value instanceof File) {
        body +=
          'Content-Disposition: form-data; name="' +
          name +
          '"; filename="' +
          escapeMultipartQuoted(value.name) +
          '"\r\n';
        body +=
          "Content-Type: " +
          (value.type.length > 0 ? value.type : "application/octet-stream") +
          "\r\n\r\n";
        body += value.bytesString();
      } else {
        body += 'Content-Disposition: form-data; name="' + name + '"\r\n\r\n';
        body += Buffer.from(value, "utf8").toString("latin1");
      }
      body += "\r\n";
    }
    body += "--" + boundary + "--\r\n";
    return { boundary, body };
  }

  static parseMultipart(body: string, contentType: string): FormData {
    const boundary = multipartBoundary(contentType);
    if (boundary.length === 0)
      throw new TypeError("Multipart boundary is missing");

    const form = new FormData();
    const delimiter = "--" + boundary;
    let boundaryAt = body.startsWith(delimiter)
      ? 0
      : findMultipartBoundary(body, delimiter, 0);
    if (boundaryAt < 0)
      throw new TypeError("Multipart boundary was not found in body");
    while (boundaryAt >= 0) {
      let partStart = boundaryAt + delimiter.length;
      if (body.slice(partStart, partStart + 2) === "--") break;
      if (body.slice(partStart, partStart + 2) !== "\r\n") {
        throw new TypeError("Malformed multipart boundary");
      }
      partStart += 2;
      const nextBoundary = findMultipartBoundary(body, delimiter, partStart);
      if (nextBoundary < 0)
        throw new TypeError("Multipart body has no closing boundary");
      const part = body.slice(partStart, nextBoundary - 2);
      boundaryAt = nextBoundary;

      const headerEnd = part.indexOf("\r\n\r\n");
      if (headerEnd < 0) throw new TypeError("Malformed multipart part");
      const rawHeaders = part.slice(0, headerEnd);
      const partBody = part.slice(headerEnd + 4);
      let disposition = "";
      let mediaType = "";
      for (const line of rawHeaders.split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon <= 0) continue;
        const headerName = line.slice(0, colon).trim().toLowerCase();
        const headerValue = line.slice(colon + 1).trim();
        if (headerName === "content-disposition") disposition = headerValue;
        else if (headerName === "content-type") mediaType = headerValue;
      }

      const name = multipartParameter(disposition, "name");
      if (
        disposition.split(";")[0].trim().toLowerCase() !== "form-data" ||
        name === null
      )
        continue;
      const fileName = multipartParameter(disposition, "filename");
      if (fileName !== null) {
        form.append(
          name,
          new File([Buffer.from(partBody, "latin1")], fileName, {
            type: mediaType,
          }),
        );
      } else {
        form.append(name, Buffer.from(partBody, "latin1").toString("utf8"));
      }
    }
    return form;
  }
}

/** Find a delimiter only where MIME framing permits one: at a CRLF line start and followed by CRLF or the closing `--`. */
function findMultipartBoundary(
  body: string,
  delimiter: string,
  start: number,
): number {
  const marker = "\r\n" + delimiter;
  let at = body.indexOf(marker, start);
  while (at >= 0) {
    const boundaryAt = at + 2;
    const suffix = body.slice(
      boundaryAt + delimiter.length,
      boundaryAt + delimiter.length + 2,
    );
    if (suffix === "\r\n" || suffix === "--") return boundaryAt;
    at = body.indexOf(marker, at + marker.length);
  }
  return -1;
}

function escapeMultipartQuoted(value: string): string {
  return value
    .split("\\")
    .join("\\\\")
    .split('"')
    .join('\\"')
    .split("\r")
    .join("%0D")
    .split("\n")
    .join("%0A");
}

function multipartBoundary(contentType: string): string {
  const value = multipartParameter(contentType, "boundary");
  return value ?? "";
}

function multipartParameter(header: string, wantedName: string): string | null {
  let at = 0;
  while (at < header.length) {
    while (
      at < header.length &&
      (header[at] === ";" || header[at] === " " || header[at] === "\t")
    )
      at++;
    const equals = header.indexOf("=", at);
    if (equals < 0) return null;
    const semicolon = header.indexOf(";", at);
    if (semicolon >= 0 && semicolon < equals) {
      at = semicolon + 1;
      continue;
    }
    const name = header.slice(at, equals).trim().toLowerCase();
    at = equals + 1;
    let value = "";
    if (at < header.length && header[at] === '"') {
      at++;
      while (at < header.length) {
        const ch = header[at];
        if (ch === '"') {
          at++;
          break;
        }
        if (ch === "\\" && at + 1 < header.length) {
          at++;
          value += header[at];
          at++;
        } else {
          value += ch;
          at++;
        }
      }
    } else {
      const end = header.indexOf(";", at);
      if (end < 0) {
        value = header.slice(at).trim();
        at = header.length;
      } else {
        value = header.slice(at, end).trim();
        at = end + 1;
      }
    }
    if (name === wantedName.toLowerCase()) return value;
    const next = header.indexOf(";", at);
    at = next < 0 ? header.length : next + 1;
  }
  return null;
}

// WHATWG Fetch §6's `BodyInit` -- the union `new Response(body, init)`/
// `new Request(url, { body })` accept. node-compat's `Response`/`Request`
// Request bodies use this concrete union so every arm crosses the generated
// ABI without a dynamic carrier. Hono's response seam uses its smaller
// `Data | null` union directly in `Response` above. `ReadableStream` here is
// the real, working `runtime/node/stream/web.ts` class -- `node-globals.ts`
// reflects it (and its readers/controllers) onto this same bare global
// scope, unconditionally; see that file for why. It used to be a second,
// deliberately empty ambient declaration IN THIS FILE (nothing built here
// constructed one through the bare name, so an unimplemented stub was
// honest) -- but `@hono/node-server`'s `utils/stream.ts` genuinely does
// (`new ReadableStream<Uint8Array>({ start, pull, cancel })`, to stream a
// static file's bytes), which needs the real `getReader`/`locked`/pipe
// surface, not a stub. Two declarations of one global is exactly the defect
// this target's docs warn about, so this file no longer states its own.
type BodyInit =
  | string
  | ArrayBuffer
  | ArrayBufferView<ArrayBuffer>
  | Buffer
  | Blob
  | FormData
  | URLSearchParams
  // WHATWG Fetch's body stream is a stream of BYTES, and so is every consumer
  // of `Response.body` here -- `@hono/node-server`'s `writeFromReadableStream`
  // takes `ReadableStream<Uint8Array>` and reads `value.byteLength` off each
  // chunk. Left at the `unknown` default, that call is a checker error at the
  // one place this target's HTTP listener streams a response.
  | ReadableStream<Uint8Array>
  | null;

// WHATWG Fetch/Web Crypto tail: names hono's own source (`utils/cookie.ts`'s
// HMAC signing, `client/*.ts`'s WebSocket upgrade and outbound `fetch`)
// references in code THIS target never calls -- hono-hello signs no cookies
// and never runs the fetch client. `BufferSource` is `standard-library.ts`'s
// (needed there for `TextDecoder.decode`); none of the rest has a
// node-compat implementation behind it, and none is in the compiler's own
// host tables (unlike `console`/`TextEncoder`/`btoa`, also in
// `standard-library.ts`), so each is declared honestly as an ambient,
// UNIMPLEMENTED type: enough shape for the checker, no fabricated behavior.
// A program that actually reached one of these calls would get an unresolved
// external, refusing by name at link time -- never a silently wrong answer.
declare class CryptoKey {
  readonly algorithm: unknown;
  readonly extractable: boolean;
  readonly type: string;
  readonly usages: string[];
}
declare class SubtleCrypto {
  importKey(
    format: string,
    keyData: BufferSource,
    algorithm: unknown,
    extractable: boolean,
    keyUsages: string[],
  ): Promise<CryptoKey>;
  sign(
    algorithm: unknown,
    key: CryptoKey,
    data: BufferSource,
  ): Promise<ArrayBuffer>;
  verify(
    algorithm: unknown,
    key: CryptoKey,
    signature: BufferSource,
    data: BufferSource,
  ): Promise<boolean>;
  // Web Crypto §14.3.3. `@hono/node-server`'s own `utils/crypto.ts` (HMAC
  // signing helper) calls this directly; same honest-ambient treatment as
  // every other member here -- no node-compat implementation exists behind
  // it, so a program that reaches it gets an unresolved external, refusing
  // by name, rather than a fabricated digest.
  digest(algorithm: unknown, data: BufferSource): Promise<ArrayBuffer>;
}
declare const crypto: { subtle: SubtleCrypto };

type BinaryType = "blob" | "arraybuffer";

interface MessageEventInit<T = any> {
  data?: T;
}

class MessageEvent<T = any> extends Event {
  readonly data: T;

  constructor(type: string, init: MessageEventInit<T> = {}) {
    super(type);
    this.data = init.data as T;
  }
}

interface CloseEventInit {
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

// Same type/value split as `Headers`/`Response`/`Request` above, and the
// same reason: `@hono/node-server`'s own `websocket.ts` feature-detects a
// platform `CloseEvent` first -- `globalThis.CloseEvent ?? class extends
// Event {...}` -- which needs `CloseEvent` reflected onto `typeof
// globalThis` (a plain `class CloseEvent` does not get there; see
// `Headers`'s comment, above, for why and how this splits the name).
class CloseEventImpl extends Event {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;

  constructor(type: string, init: CloseEventInit = {}) {
    super(type);
    this.code = init.code ?? 0;
    this.reason = init.reason ?? "";
    this.wasClean = init.wasClean ?? false;
  }
}

type CloseEvent = CloseEventImpl;
var CloseEvent: typeof CloseEventImpl = CloseEventImpl;

interface ErrorEventInit {
  error?: unknown;
  message?: string;
}

// Same split, and the same reason: `websocket.ts` reads
// `globalThis.ErrorEvent` too.
class ErrorEventImpl extends Event {
  readonly error: unknown;
  readonly message: string;

  constructor(type: string, init: ErrorEventInit = {}) {
    super(type);
    this.error = init.error;
    this.message = init.message ?? "";
  }
}

type ErrorEvent = ErrorEventImpl;
var ErrorEvent: typeof ErrorEventImpl = ErrorEventImpl;

declare class WebSocket {
  constructor(url: string, protocols?: string | string[]);
  readonly url: string;
  close(code?: number, reason?: string): void;
  send(data: string): void;
}
// `hono/client`'s `Fetch` type alias (`client/types.ts`) is `typeof fetch`;
// the client itself is never constructed by anything this target builds.
declare function fetch(
  input: string | Request,
  init?: RequestInit,
): Promise<Response>;
