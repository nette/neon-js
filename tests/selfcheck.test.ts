import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { corpusDir, loadCases } from './corpus.ts';


// The loader refuses a corpus it cannot trust, instead of running fewer cases.
test('the loader fails on a broken corpus', () => {
	const dir = mkdtempSync(join(tmpdir(), 'neon-loader-'));
	try {
		const root = join(dir, 'corpus');
		const decode = join(root, 'decode');
		mkdirSync(decode, { recursive: true });
		expect(() => loadCases('decode', root)).toThrow('VERSION');
		mkdirSync(join(dir, 'spec'));
		writeFileSync(join(dir, 'spec', 'VERSION'), readFileSync(join(corpusDir, '..', 'spec', 'VERSION')));
		expect(() => loadCases('decode', root)).toThrow('Empty category');
		expect(() => loadCases('cst', root)).toThrow('Missing category');

		writeFileSync(join(decode, 'a.neon'), '1');
		expect(() => loadCases('decode', root)).toThrow('Missing .json');
		writeFileSync(join(decode, 'a.json'), '{"type": "int", "value": "1"}');
		expect(loadCases('decode', root)).toHaveLength(1);

		for (const [file, content, message] of [
			['b.json', '{}', 'without its input'],
			['a.dump', '', 'Unknown file'],
			['a.case.json', '{"schema": 1, "extra": true}', 'Unknown field'],
			['a.case.json', '{"schema": 2}', 'Unknown schema'],
			['a.case.json', '{"schema": 1, "php3": "open", "reason": "x"}', 'open deviation'],
			['a.case.json', '{"schema": 1, "hosts": ["js"]}', 'without reason'],
			['a.case.json', '{"schema": 1, "hosts": ["java"], "reason": "x"}', 'Invalid hosts'],
			['a.case.json', '{"schema": 1, "blockMode": 1}', 'Invalid blockMode'],
		]) {
			writeFileSync(join(decode, file!), content!);
			expect(() => loadCases('decode', root), file + ' ' + content).toThrow(message);
			rmSync(join(decode, file!));
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});


// The runners must fail on a broken expectation; a runner that cannot fail proves nothing.
// A copy of the corpus with one expectation per category broken is run in a child vitest.
test('the runners fail on broken expectations', async () => {
	const top = mkdtempSync(join(tmpdir(), 'neon-selfcheck-'));
	const dir = join(top, 'corpus');
	try {
		mkdirSync(join(top, 'spec'));
		writeFileSync(join(top, 'spec', 'VERSION'), readFileSync(join(corpusDir, '..', 'spec', 'VERSION')));
		for (const category of readdirSync(corpusDir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
			mkdirSync(join(dir, category.name), { recursive: true });
			for (const file of readdirSync(join(corpusDir, category.name))) {
				writeFileSync(join(dir, category.name, file), readFileSync(join(corpusDir, category.name, file)));
			}
		}
		writeFileSync(join(dir, 'decode', 'basic-001.json'), '{"type": "int", "value": "999"}\n');
		writeFileSync(join(dir, 'errors', 'basic-001.error'), 'Some other message\n1:1\n');
		writeFileSync(join(dir, 'encode', 'basic-001.neon'), 'broken');
		writeFileSync(join(dir, 'cst', 'literal.dump'), 'DocumentNode\n');
		writeFileSync(join(dir, 'mutations', 'add-block.expected.neon'), 'broken');

		const { startVitest } = await import('vitest/node');
		process.env.NEON_CORPUS = dir;
		const vitest = await startVitest('test', ['tests/corpus.test.ts', 'tests/mutations.test.ts'], { watch: false, reporters: [] });
		const failed = vitest.state.getFiles().flatMap((file) => file.tasks).flatMap(function collect(task): string[] {
			return 'tasks' in task ? task.tasks.flatMap(collect) : task.result?.state === 'fail' ? [task.name] : [];
		});
		await vitest.close();
		delete process.env.NEON_CORPUS;
		expect(failed.sort()).toEqual(['add-block', 'basic-001', 'basic-001', 'basic-001', 'literal'].sort());
	} finally {
		rmSync(top, { recursive: true, force: true });
	}
}, 120_000);
