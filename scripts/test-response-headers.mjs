import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

// Exercise the actual shim source against Node's Fetch implementation. Native
// compilation of the same string/default/explicit-header paths is covered by
// test-hono.mjs after build.mjs --globals.
// `whatwg-streams.ts` FIRST, and in the same context rather than as an import.
// That is not a harness convenience -- it is what the compiled program does.
// Both files are SCRIPTS (no top-level import/export), so their declarations
// land in one shared global scope, which is how `globals.ts` resolves the bare
// `ReadableStream` its `Request`/`Response` constructors name. Loading
// `globals.ts` alone leaves that undefined, which is exactly what this harness
// started failing on once the stream classes moved out of an ambient `const`
// and into their own script.
const read = (name) =>
  stripTypeScriptTypes(
    readFileSync(new URL(`../runtime/node/${name}.ts`, import.meta.url), "utf8"),
  );
const shim = runInNewContext(
  `${read("abort-events")}\n${read("whatwg-streams")}\n${read("globals")}\n({ Headers, Response, Request })`,
  { Buffer, queueMicrotask, TextEncoder, TextDecoder, URL, console },
);
for (const body of [undefined, null, "", "hello"]) {
  for (const headers of [
    undefined,
    {},
    { "Content-Type": "custom/type" },
    { "Content-Type": "" },
  ]) {
    const actual = new shim.Response(
      body,
      headers === undefined ? undefined : { headers },
    );
    const expected = new Response(
      body,
      headers === undefined ? undefined : { headers },
    );
    // Node spells the string-body default the WHATWG way,
    // `text/plain;charset=UTF-8`. The shim spells it with a space, the way
    // `@hono/node-server`'s own Response replacement does, because that
    // package's wire is what a compiled Hono build is checked against --
    // see the comment on the assignment in `globals.ts`. That one divergence
    // is deliberate and pinned here; every other header must still agree with
    // Node exactly, which is the whole point of comparing against it.
    const expectedType = expected.headers
      .get("content-type")
      ?.replace(/^text\/plain;charset=UTF-8$/, "text/plain; charset=UTF-8");
    assert.equal(actual.headers.get("content-type"), expectedType ?? null);
    assert.equal(await actual.text(), await expected.text());
  }
}
for (const name of ["Response", "Request"]) {
  const original = new shim.Headers({
    "X-Copy": "before",
    "Content-Type": "custom/type",
  });
  const copy = new shim[name](
    name === "Request" ? "http://localhost/" : "hello",
    { headers: original },
  );
  original.set("X-Copy", "after");
  assert.equal(copy.headers.get("x-copy"), "before");
  assert.equal(copy.headers.get("content-type"), "custom/type");
}
console.log(
  "PASS: 16 Response body/header cases match Node; Request and Response copy typed Headers independently",
);
