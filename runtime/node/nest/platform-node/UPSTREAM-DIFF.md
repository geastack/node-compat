# Edits against upstream (nestjs/nest `feat/platform-node` @ 2b10fb2)

Policy: the vendored files are edited only where the whole-program `strict`
checking of this target rejects code platform-node compiles under its own
`noImplicitAny: false` / `useUnknownInCatchVariables: false` tsconfig, and
each edit is listed here with the upstream line. Behaviour is unchanged.

| File | Upstream line | Edit | Why |
|---|---|---|---|
| `body-parser/body-parser.ts` | 657 `throw toParseError(error, text);` | `error instanceof Error ? error : new SyntaxError(String(error))` | catch variable is `unknown` under `strict`; `toParseError` takes `Error`. `JSON.parse` and `secure-json-parse` only ever throw `SyntaxError`, so the fallback branch is unreachable in practice. |
