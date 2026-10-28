# Internals

How `@nette/neon` works where it is not obvious from the code. The format, the tree and the
semantics of editing are defined by the specification (`tests/neon-spec/spec/`); this document
covers what is specific to this implementation.


## Map

| module | role |
|---|---|
| `scanner.ts` | the hand-written scanner of grammar.md §1; no regex reads tokens |
| `lexer.ts` | tokens with trivia attached by the convention; positions; `quote()` of error messages |
| `token.ts` | `Token`, `Trivia`, the setters that keep trivia canonical |
| `parser.ts` | the parser of nette/neon 3.x ported onto tokens |
| `nodes.ts` | node classes, slots, queries, the facade methods of editing |
| `values.ts` | evaluation of literals and strings, canonical keys, `NeonDate`, `Entity` |
| `encoder.ts` | `encode()`, the one source of how a value is written |
| `builder.ts` | nodes from host values: encode, then parse |
| `editing.ts` | every mutation (mutations.md) |
| `layout.ts` | indentation unit, indentation of an item, line ending |
| `printer.ts`, `dumper.ts`, `traverser.ts`, `utf8.ts`, `cli.ts` | as named; only `cli.ts` uses Node |


## Parsing

- **The parser is the algorithm of 3.x, not a new one.** Its error messages and positions are
  part of the contract, and they come from the order in which 3.x looks at tokens. Keep the
  structure of `parseBlock()`, `parseBraces()` and `parseEntity()` parallel to
  `Nette\Neon\Parser` of 3.x; a "cleaner" parser that accepts the same inputs still fails the
  corpus on the errors.
- **In an inline array, a value on the line after a key is the value of that key**, unlike in
  3.x (specification 1.1). It is read once; when a colon follows it, it is handed over as the key
  of the next item instead of being parsed again.
- **Line endings are trivia, but the parser sees them.** Before token *i* stands a line break
  when the trailing trivia of token *i-1* contain a line ending; the stream presents it as the
  pseudo-kind `Newline`, consumed once per gap, as the run of Newline tokens of 3.x was. An error
  at such a place quotes `<new line>` once per adjacent line ending.
- **The block on the line of a dash does not backtrack**, unlike 3.x, which tries a tab and then
  two spaces: that costs time exponential in the number of nested dashes. Its indentation is a
  `PendingIndent`, decided on the line where the block first compares it; when a block decided
  for the tab fails, `parseDashBlock()` reports `Invalid combination of tabs and spaces` on that
  line, which is where the attempt with spaces of 3.x fails. The differential runs show the
  same results and errors as 3.x.
- **Arrays nest at most 500 levels** (`MaxDepth`): the parser counts them in `enter()`, the
  encoder and `checkDepth()` of editing refuse to create deeper ones, so recursion elsewhere
  stays far from the stack limit.
- **Scalars are evaluated while parsing** (escapes, the reserved `!!chain`, implicit
  key overflow), so `parse()` rejects everything `decode()` would, and `neon-lint` only parses.
- `verify()` checks after every parse that the tree holds exactly the tokens of the stream, by
  identity and order; it is a check in the code, not only in tests.


## The tree

- A slot is written through `adopt()`, which refuses a node with a parent or a node that would
  become its own ancestor, and releases the previous child. Lists are frozen arrays replaced
  through the internal `[setItems]`; raw slot writes go through `[setSlots]`, raw trivia writes
  through `[setLeading]` and `[setTrailing]`. The symbols are in `internal.ts` and not exported
  from the package.
- **The public setters are editing operations, never raw writes**: `item.value = node` is
  `setItemNode()`, `document.value = node` is `setDocumentNode()`, and the trivia setters of a
  token in a document check its neighbours (model.md §2.3). Editing code uses only the raw
  symbols, because it moves trivia in steps whose intermediate states are not canonical.
- Constructors of nodes are `@internal` and check no shape: only the parser, `clone()` and the
  editing code call them, with tokens and children valid by construction. A node from outside
  comes from `parse()`, `clone()` or `detach()`/`remove()`, and the editing operations check
  what depends on where it is put (model.md §2.3). The lexer and `clone()` make tokens through
  `trustedToken()`, which skips the scan of the text.
- `nodes.ts` and `editing.ts` import each other. That works because neither uses the other at
  the top level of the module; keep it so (no `extends` across them, no top-level calls).
- `Token.getPosition()` walks the whole document, which is fine for configuration files; an
  editor that needs many positions uses `locateAll()`.


## Editing

- **A refused edit changes nothing**, for two reasons. The checks that can run first do so
  (shape, ownership, cycles, duplicate keys), before the first trivia move. And every public
  mutation runs in `atomic()` (`internal.ts`): while it runs, each raw write of a token or a node
  records how to undo itself, and an exception undoes them all, so a late refusal (an implicit
  key out of range found by `keepKeys()`) and a donor tree are covered too. A new mutation must
  be entered through `atomic()`, and a new private field that an edit writes must `record()`.
- **`replaceWith()` and `detach()` are decided by the slot** (`parent.value === node`, the key,
  the head, attributes or link of an entity), not by the class of the parent.
- **Writing an equal value is a no-op** by `valuesEqual()` (values.md §1), arrays in the order of
  the document; it does not depend on whether the value can be encoded.
- **The root is a place of its own**: a block there gets the indentation of the old root block,
  and the first value of an empty document takes the trivia of `EndOfFile` before itself.
- **New text comes from `encode()`**: `Builder` encodes the value, indents it for its place, parses
  it and takes the nodes out of that temporary document. Do not build tokens by hand for values.
- After an edit, `keepKeys()` writes out implicit keys that would otherwise change, and
  `guardGrammar()` defuses the traps of mutations.md §4a; every public operation that changes an
  array calls them. A new operation must too.
- `splitLeading()` decides what an item owns: the comment lines directly above it and its
  indentation; the byte order mark always stays with the document.


## Tests

- `tests/corpus.test.ts` and `tests/mutations.test.ts` run every category of the corpus, loaded
  by a strict validator (`tests/corpus.ts`); `tests/mutation-fuzz.test.ts` edits the documents of
  the corpus at random against an ordered model of lists and maps, puts nodes of other documents
  into slots, attempts operations that must be refused and compares a snapshot after each
  refusal (`FUZZ_SEEDS=100000` for a long run with counts, `FUZZ_SEED=n` to replay one).
- `tests/differential.ts` compares with nette/neon 3.4 over files or fuzzed documents, given the
  output of `php-oracle.php outcomes` or `fuzz.php` from the specification repository.
- `NEON_EXTERNAL_CORPUS=dir;dir` adds a round trip over real-world files.
