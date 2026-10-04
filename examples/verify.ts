// Runs every example a chapter readme names under a heading and compares its output with the first
// plain fenced block under that heading. Usage: npx tsx examples/verify.ts

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const root = import.meta.dirname;
let failures = 0;
let checked = 0;

for (const chapter of readdirSync(root).filter((entry) => statSync(join(root, entry)).isDirectory()).sort()) {
	const dir = join(root, chapter);
	const readme = join(dir, 'readme.md');
	if (!existsSync(readme)) {
		console.log(`FAIL ${chapter}: no readme.md`);
		failures++;
		continue;
	}

	const text = readFileSync(readme, 'utf8').replaceAll('\r\n', '\n');
	const quoted = (new Map<string, string>);
	for (const [, heading, body] of text.matchAll(/^## .*\((\S+\.ts)\)\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)) {
		const block = /^```\n([\s\S]*?)^```$/m.exec(body!);
		if (!block) {
			console.log(`FAIL ${chapter}/${heading}: no output block under the heading`);
			failures++;
			continue;
		}
		quoted.set(heading!, block[1]!);
	}

	for (const script of readdirSync(dir).filter((file) => file.endsWith('.ts')).sort()) {
		const expected = quoted.get(script);
		if (expected === undefined) {
			console.log(`FAIL ${chapter}/${script}: the readme quotes no output of it`);
			failures++;
			continue;
		}
		const actual = execFileSync(process.execPath, ['--import', 'tsx', join(dir, script)], { encoding: 'utf8' }).replaceAll('\r\n', '\n');
		checked++;
		if (actual !== expected) {
			console.log(`FAIL ${chapter}/${script}: the output differs from the readme\n--- expected\n${expected}--- actual\n${actual}`);
			failures++;
		}
		quoted.delete(script);
	}

	for (const script of quoted.keys()) {
		console.log(`FAIL ${chapter}: the readme names ${script}, which does not exist`);
		failures++;
	}
}

// the TypeScript blocks of the main readme must at least parse
const readme = readFileSync(join(root, '..', 'readme.md'), 'utf8').replaceAll('\r\n', '\n');
for (const [, code] of readme.matchAll(/^```ts\n([\s\S]*?)^```$/gm)) {
	const result = ts.transpileModule(code!, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2024 } });
	checked++;
	if (result.diagnostics?.length) {
		console.log(`FAIL readme.md: ${ts.flattenDiagnosticMessageText(result.diagnostics[0]!.messageText, '\n')} in\n${code}`);
		failures++;
	}
}

console.log(`${checked} examples, ${failures} failures`);
process.exitCode = failures ? 1 : 0;
