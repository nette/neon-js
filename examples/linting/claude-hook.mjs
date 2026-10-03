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
