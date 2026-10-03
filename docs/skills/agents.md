# NEON for AI agents

An agent that edits configuration files should learn about a broken file the moment it breaks
it, not when the application fails to start. This guide sets that up with `neon-lint`, and shows
how an agent should edit NEON when it has to.

`@nette/neon` is the implementation to use for this, whatever the language of the project: Node is
on every machine an agent runs on, and `neon-lint` has the same output and exit codes in every
implementation of NEON.


## 1. Install it into the project

```shell
npm install --save-dev @nette/neon
npx neon-lint config/
```

A hook runs after every edit, so it must not depend on the network or on a cache:
`npx --yes --package=@nette/neon neon-lint` works for a one-off check, but a hook should call the
locally installed package.

The output is one line per finding, `<path>:<line>:<column>: <message>`, and the exit code is the
verdict: 0 valid, 1 a finding, 2 a wrong invocation or a failure of the linter itself.


## 2. Claude Code

A `PostToolUse` hook on `Edit|Write` lints the file the agent has just written. Exit code 2 of a
hook hands its output back to the agent as an error, so it fixes the file before it goes on. Any
other non-zero code is shown to the user; the hook uses it when the linter itself fails or is
missing, so an unchecked file never passes for a valid one. The hook is
`examples/linting/claude-hook.mjs` of the package, which its tests run.

`.claude/hooks/neon-lint.mjs`:

```js
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

let input = '';
for await (const chunk of process.stdin) {
	input += chunk;
}

const file = JSON.parse(input).tool_input?.file_path ?? '';
if (!file.endsWith('.neon')) {
	process.exit(0);
}

const linter = 'node_modules/@nette/neon/bin/neon-lint.js';
const lint = existsSync(linter) ? spawnSync(process.execPath, [linter, file], { encoding: 'utf8' }) : null;
if (lint?.status === 0) {
	process.exit(0);
} else if (lint?.status === 1) { // findings: exit code 2 hands them to the agent, which fixes the file
	process.stderr.write(lint.stdout);
	process.exit(2);
}
// the linter itself failed: the user sees it, and the file stays unchecked
process.stderr.write(`neon-lint could not check ${file}: ${lint ? lint.error?.message ?? (lint.stderr || `exit code ${lint.status}`) : `${linter} is missing`}\n`);
process.exit(1);
```

`.claude/settings.json`:

```json
{
	"hooks": {
		"PostToolUse": [
			{
				"matcher": "Edit|Write",
				"hooks": [{ "type": "command", "command": "node .claude/hooks/neon-lint.mjs" }]
			}
		]
	}
}
```

After an edit that leaves `services:` with an unclosed entity, the agent gets:

```
config/services.neon:3:1: Unexpected end
```

The hook runs after the edit; it does not prevent a broken file from being saved, but it makes
sure the break does not go unnoticed.


## 3. Other agents

Codex, Cursor, Copilot and others have their own ways to run a command after an edit. Wherever
there is none, put the rule into the instructions of the project (below): run `neon-lint` after
every change of a `.neon` file and treat a non-zero exit code as a failure to fix.


## 4. A snippet for `AGENTS.md`

```markdown
## NEON files

- After every change of a `.neon` file, run `npx neon-lint <file>`; exit code 0 is the only
  acceptable result. The message says the line and the column.
- Indentation is structure: a tab, or the spaces the file already uses. Never mix them in one block.
```


## 5. Editing NEON from a program

When an agent writes a script that changes configuration, it should edit the tree, not the text
with regular expressions. The tree keeps comments, blank lines, indentation and the style of
values, and every edit leaves a valid file:

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from '@nette/neon';

const doc = parse(readFileSync('config/common.neon', 'utf8'));
doc.setValue(['database', 'host'], 'db.example.com');
doc.setValue(['extensions', 'my'], 'App\\DI\\MyExtension');
doc.removeItem(['parameters', 'legacyOption']);
writeFileSync('config/common.neon', doc.print());
```

`setValue()` on a path whose last key is missing adds it, a missing key in the middle of the path
is an error (a typo does not create a section), and writing a value that is already there changes
nothing. See `examples/editing` for what each operation does to the text.
