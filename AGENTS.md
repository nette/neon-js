# To My Agents!

It is my fervent wish that this file guide every AI coding agent working with code in this repository.

## Documentation

`docs/internals.md` describes how the library works where the code does not say it: why the
parser is the algorithm of nette/neon 3.x, how line endings reach the parser, what every edit
must check first and call last. Read it before changing `parser.ts`, `nodes.ts` or `editing.ts`.
`docs/skills/agents.md` is the guide for users who want `neon-lint` as a hook of their agent.

The format, the value model, the tree and the editing semantics are defined by the
language-neutral specification in `tests/neon-spec/spec/` (checked out by `npm run spec`
from `nette/neon-specification` at the commit of `tests/neon-spec.lock`, with the conformance corpus). The specification is the
source of truth; `spec/model.md` is the one home of the names of token kinds, nodes,
slots and methods. Do not copy it here.

## Project overview

`@nette/neon` parses NEON into a lossless concrete syntax tree, prints it back byte for
byte, edits it while keeping comments and formatting, and decodes and encodes values.
TypeScript, no runtime dependencies, runs in Node and in the browser (the core uses no
Node API; `src/cli.ts` and `bin/neon-lint.js` do).

## Essential commands

```bash
git submodule update --init   # the corpus
npm ci                        # the toolchain of package-lock.json
npm test                      # tsc --noEmit, the core without Node types, then vitest
npm run lint                  # and lint:fix (@nette/eslint-plugin)
npm run build                 # src/ -> dist/; bin/neon-lint.js runs dist/
npm run verify-examples       # the examples print what their readmes quote
npm run smoke                 # the packed package installed into a clean project
NEON_EXTERNAL_CORPUS="/path/a;/path/b" npm test   # round trip over real-world .neon files too
FUZZ_SEEDS=100000 npx vitest run tests/mutation-fuzz.test.ts   # a long run of random edits
```

## Conventions

- Strict TypeScript, ES2024, `verbatimModuleSyntax`, imports with the `.ts` extension
  (rewritten on build). Tabs, `@nette/eslint-plugin`.
- A property is a stored value, a method is work: values of nodes are `toValue()`,
  positions are `getPosition()`.
- Tests are vitest. `tests/corpus.test.ts` and `tests/mutations.test.ts` walk every
  category of the corpus, one test per case; a runner that skips an unknown field or an
  empty category is a bug. Unit tests cover only what the corpus cannot say (positions,
  host values, the CLI).
- `examples/` is the documentation of the API: a chapter readme quotes the real output of
  each of its programs, and `verify-examples` fails when they differ. An API change shows
  in the examples first.

## Working in this repo

- **The scanner is hand-written** (`src/scanner.ts`) after grammar.md §1; a lone CR is a
  space in every rule. Positions are counted in code points; `Position.utf16Offset` is
  the index into the JavaScript string.
- **Trivia attach by one rule**: trailing trivia of a token run up to and including the
  first line ending, the rest is leading trivia of the next token. `src/lexer.ts`
  applies it, the setters of `Token` keep it.
- **A behaviour that differs from nette/neon 3.x is a case of the corpus first**, with its
  classification in the sidecar, then code.
- A change of the corpus is a commit in `nette/neon-specification`; this repository then moves
  `tests/neon-spec.lock` in a commit of its own.
