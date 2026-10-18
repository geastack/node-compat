# Edits against upstream (nestjs/nest `feat/platform-node` @ 2b10fb2)

Policy: the vendored files are edited only where the whole-program `strict`
checking of this target rejects code platform-node compiles under its own
`noImplicitAny: false` / `useUnknownInCatchVariables: false` tsconfig, and
each edit is listed here with the upstream line. Behaviour is unchanged.

| File | Upstream line | Edit | Why |
|---|---|---|---|
