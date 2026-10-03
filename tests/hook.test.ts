import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';


// The hook for agents of the guide: a finding goes to the agent, a failure of the linter to the user.

const hook = join(import.meta.dirname, '..', 'examples', 'linting', 'claude-hook.mjs');


test('the guide shows the hook as it is', () => {
	const read = (file: string) => readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
	const guide = read(join(import.meta.dirname, '..', 'docs', 'skills', 'agents.md'));
	expect(guide).toContain('```js\n' + read(hook) + '```');
});


test('the hook tells a finding from a failure of the linter', () => {
	const dir = mkdtempSync(join(tmpdir(), 'neon-hook-'));
	try {
		const run = (file: string) => {
			const res = spawnSync(process.execPath, [hook], { cwd: dir, input: JSON.stringify({ tool_input: { file_path: file } }), encoding: 'utf8' });
			return [res.status, res.stderr];
		};
		expect(run('readme.md')).toEqual([0, '']);
		expect(run('a.neon')).toEqual([1, 'neon-lint could not check a.neon: node_modules/@nette/neon/bin/neon-lint.js is missing\n']);

		// a stand-in for the linter, with the exit code the name of the file asks for
		mkdirSync(join(dir, 'node_modules', '@nette', 'neon', 'bin'), { recursive: true });
		writeFileSync(join(dir, 'node_modules', '@nette', 'neon', 'bin', 'neon-lint.js'), [
			'const file = process.argv[2];',
			'const code = Number(/(\\d)\\.neon$/.exec(file)[1]);',
			'(code === 1 ? process.stdout : process.stderr).write(code ? `${file}:1:1: Unexpected end\\n` : "");',
			'process.exitCode = code;',
		].join('\n'));
		expect(run('valid-0.neon')).toEqual([0, '']);
		expect(run('broken-1.neon')).toEqual([2, 'broken-1.neon:1:1: Unexpected end\n']);
		expect(run('internal-2.neon')).toEqual([1, 'neon-lint could not check internal-2.neon: internal-2.neon:1:1: Unexpected end\n\n']);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
