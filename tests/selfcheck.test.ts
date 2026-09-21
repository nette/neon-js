import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
