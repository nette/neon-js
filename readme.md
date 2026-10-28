NEON for JavaScript
===================

[![npm](https://img.shields.io/npm/v/@nette/neon.svg)](https://www.npmjs.com/package/@nette/neon)
[![Tests](https://github.com/nette/neon-js/actions/workflows/tests.yml/badge.svg?branch=master)](https://github.com/nette/neon-js/actions)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/nette/neon-js/blob/master/license.md)

 <!---->

<h3>

✅ A NEON parser that keeps [every comment and space](#the-tree-nodes-slots-tokens-trivia)<br>
✅ [Edit a configuration file](#format-preserving-editing) and the diff is only your change<br>
✅ [`neon-lint`](#for-editors-and-ai-agents) for editors, CI and AI agents<br>
✅ [No dependencies](#installation), runs in Node and in the browser

</h3>

 <!---->

**NEON parser, encoder and lossless editor for JavaScript and TypeScript.** NEON is the
human-friendly configuration format of the Nette framework, a YAML alternative with entities.
This library parses it into a concrete syntax tree in which every character of the file has
its place, so printing the tree gives the file back byte for byte:

```ts
const doc = parse(text);
doc.print() === text;   // true, for any input NEON accepts
```

That is what makes editing safe. Change a value, add a key, remove an item, and the rest of the
file stays as its author wrote it:

```ts
doc.setValue(['database', 'host'], 'db.example.com');
```

```
- 	host: localhost   # the server
+ 	host: db.example.com   # the server
```

On that you build configuration editors and admin panels, installers that register an extension
in `config.neon`, migrations that rename a service, and AI agents that change configuration
without wrecking it.

The library comes from David Grudl, the author of [Nette](https://nette.org),
[Latte](https://latte.nette.org) and [Tracy](https://tracy.nette.org). NEON has been the
configuration format of Nette since 2011, read by every Nette application, and this
implementation follows the same specification as [nette/neon](https://github.com/nette/neon) for PHP.

 <!---->

NEON in one minute
==================

```neon
# mappings and sequences, indented by tabs or spaces
database:
	host: localhost
	port: 3306

roles: [guest, member, admin]   # inline arrays

# entities: a value with attributes, the way Nette writes services
mailer: App\Mailer(@smtp, timeout: 30)

note: '''
	multiline strings
	without escaping
'''
```

JSON is a subset of NEON, except for a colon at the start of a line glued to its value
(`"a"` + new line + `:1`), which NEON reads as a literal. The format is described at
[ne-on.org](https://ne-on.org) and in the [manual](https://doc.nette.org/en/neon/format).

▶ Runnable examples: [examples/edge-cases](examples/edge-cases/)

 <!---->

Why NEON, if YAML exists
========================

YAML is widespread and its libraries are mature. NEON did not start as its replacement but as the
configuration format of Nette, and it has three things YAML does not have or has differently:

- **entities**: `Column(type: int, nullable: true)` is a value, and the configuration of the DI
  container of Nette lives on it;
- **tabs** for indentation;
- **a smaller language**: no anchors, tags, directives or multi-document streams, and no flow
  and block styles with different meanings.

Both read JSON.

 <!---->

Format-preserving editing
=========================

Most YAML libraries, like js-yaml, drop comments and formatting when they write a file; those
that keep them, like the `yaml` package, document where they cannot. Here it is an invariant, not
an effort: every edit changes the tokens it edits, and the four guarantees of the specification
(the file reads back as the same tree, with the expected value, with the change only where it was
made) are checked after every operation of a large corpus of edits.

```ts
import { CommentPolicy, parse } from '@nette/neon';

const doc = parse(text);
doc.setValue(['database', 'port'], 3307);          // 0x0CEA stays hexadecimal: 0x0CEB
doc.setValue(['database', 'debug'], false);        // yes becomes no, not false
doc.setValue(['timeout'], 30);                     // the same value: no change at all
doc.setValue(['parameters', 'admin'], 'a@b.cz');   // a new key, indented like its siblings
doc.addItem(['services'], 'App\\OrderFacade');     // a new item of a list
doc.removeItem(['database', 'driver']);            // with the comment that describes it
doc.removeItem(['mail'], { comments: CommentPolicy.MoveToNextToken });
```

A missing key in the middle of a path is an error, so a typo does not create a new section.
Removing the last item of a collection leaves it empty (`services: []`), because in a
configuration empty and missing often mean different things; an item marked `nullable` loses its
value instead.

▶ Runnable examples: [examples/editing](examples/editing/), [examples/config-editor](examples/config-editor/)

 <!---->

Installation
============

```shell
npm install @nette/neon
```

ES module, TypeScript types included, Node 22 or newer, or any current browser. No dependencies.
The core uses no Node API; only the `neon-lint` command does.

 <!---->

The tree: nodes, slots, tokens, trivia
======================================

```ts
const item = doc.findItem(['database', 'user']);
item.getValue();                // 'root'
item.getTrailingComments();     // the comment on its line
item.value.getFirstToken().text; // the text exactly as written
item.getPosition();             // { line, column, offset }, computed from the current tree
```

Eight node classes (`DocumentNode`, `BlockArrayNode`, `InlineArrayNode`, `ArrayItemNode`,
`EntityNode`, `EntityChainNode`, `StringNode`, `LiteralNode`) with named slots, tokens with their
trivia (whitespace, line endings, comments), `find()`, `findAncestor()`, siblings, and
`Traverser` for a walk with replacements.

▶ Runnable examples: [examples/tree](examples/tree/)

 <!---->

Decoding and encoding
=====================

```ts
import { decode, encode } from '@nette/neon';

decode('a: [1, 2]');                 // { a: [1, 2] }
encode({ a: [1, 2] });               // '{a: [1, 2]}'
encode({ a: [1, 2] }, true);         // 'a:\n\t- 1\n\t- 2\n\n'
encode({ a: [1, 2] }, (_, path) => !path.length);   // 'a: [1, 2]\n', blocks for the first level only
encode(config, (value) => !Array.isArray(value));   // lists on one line
```

| NEON | JavaScript |
|---|---|
| `null`, `true`, `yes` ... | `null`, `boolean` |
| integer | `number`, beyond 2^53 a `bigint` |
| float | `number` |
| string | `string` |
| date | `NeonDate` (components and offset as written; `toDate(zone)` for an instant) |
| entity, chain | `Entity` |
| list | `Array` |
| map | plain object with own properties, so `__proto__` is just a key |

Two differences from PHP follow from JavaScript: an integral float like `1.0` is a `number` like
`1` and is written as `1`, and a plain object orders integer-like keys first (the tree keeps the
order of the file).

▶ Runnable examples: [examples/parsing](examples/parsing/), [examples/encoding](examples/encoding/)

 <!---->

One format, one specification
=============================

The format, the value model, the tree and the semantics of editing are written down in a
language-neutral [specification](https://github.com/nette/neon-specification) with a conformance corpus,
and every implementation runs that corpus in its tests. The values and the error messages were
checked against nette/neon for PHP over 95,000 real-world files. The corpus is public; if you write
an implementation of NEON for another language, use it.

 <!---->

For editors and AI agents
=========================

```shell
npx neon-lint config/
```

```
config/local.neon:3:2: Duplicated key 'user'
```

One line per finding, the exit code as the verdict, `--json` for tools.
Editor plugins exist for PhpStorm, VS Code, Sublime Text, Vim and Emacs.

For **AI agents**, a short hook gives the agent an error right after it saves a broken `.neon`
file, so it fixes it before it goes on. The hook runs after the edit; it does not
prevent a broken save, but it makes sure it does not go unnoticed. See
[docs/skills/agents.md](docs/skills/agents.md).

▶ Runnable examples: [examples/linting](examples/linting/)

 <!---->

Limits
======

- No formatter: the library keeps your formatting, it does not impose one.
- No schema or validation of values.
- No error recovery: an invalid file is reported, not partially parsed.
- Positions are computed on request, from the current tree.

 <!---->

Documentation and credits
=========================

The [examples](examples/) are the documentation of the API, each chapter with the real output of
its programs. The format itself is documented in the [Nette manual](https://doc.nette.org/en/neon).

Released under the [MIT license](license.md).
