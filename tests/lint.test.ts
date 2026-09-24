import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { main } from '../src/cli.ts';


let dir: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'neon-lint-'));
	writeFileSync(join(dir, 'valid.neon'), 'a: 1\n');
	writeFileSync(join(dir, 'invalid.neon'), 'a: 1\n  b: 2\n');
	mkdirSync(join(dir, 'sub'));
	writeFileSync(join(dir, 'sub', 'utf8.neon'), Buffer.from([0x61, 0x3A, 0x20, 0xC3, 0x28]));
	mkdirSync(join(dir, 'vendor'));
	writeFileSync(join(dir, 'vendor', 'skipped.neon'), '{');
	mkdirSync(join(dir, '.hidden'));
	writeFileSync(join(dir, '.hidden', 'skipped.neon'), '{');
	writeFileSync(join(dir, 'other.txt'), '{');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));


function run(args: string[], stdin = ''): { code: number; out: string; err: string; raw?: string } {
	let out = '';
	let err = '';
	const code = main(args, {
		out: (text) => out += text,
		err: (text) => err += text,
		stdin: () => Buffer.from(stdin),
	});
	const res = { code, out: out.replaceAll(dir, '<dir>').replaceAll('\\', '/'), err };
	return Object.defineProperty(res, 'raw', { value: out }); // not enumerable, so toEqual() ignores it
}


test('valid files', () => {
	expect(run([join(dir, 'valid.neon')])).toEqual({ code: 0, out: '', err: '' });
	expect(run(['--verbose', join(dir, 'valid.neon')])).toEqual({ code: 0, out: 'OK 1 files\n', err: '' });
	expect(run(['--check', join(dir, 'valid.neon'), join(dir, 'valid.neon')]).code).toBe(0);
});


test('findings in a directory, sorted, skipping vendor and hidden directories', () => {
	expect(run([dir])).toEqual({
		code: 1,
		out: '<dir>/invalid.neon:2:3: Bad indentation\n<dir>/sub/utf8.neon:1:4: Invalid UTF-8 sequence.\n',
		err: '',
	});
	expect(run(['--quiet', dir])).toEqual({ code: 1, out: '', err: '' });
	expect(JSON.parse(run(['--json', join(dir, 'invalid.neon')]).raw!)).toEqual([
		{ path: join(dir, 'invalid.neon'), line: 2, column: 3, message: 'Bad indentation' },
	]);
});


test('standard input', () => {
	expect(run(['-'], 'a: [')).toEqual({ code: 1, out: '-:1:5: Unexpected end\n', err: '' });
	expect(run(['-'], 'a: 1').code).toBe(0);
});


test('wrong invocations', () => {
	expect(run([]).code).toBe(2);
	expect(run(['--bogus', dir]).code).toBe(2);
	expect(run(['--dump', '-'], 'a')).toEqual({ code: 2, out: '', err: expect.stringContaining('Unknown option --dump') });
	expect(run([join(dir, 'missing')])).toEqual({ code: 1, out: '<dir>/missing: No file found\n', err: '' });
	expect(run(['--help']).code).toBe(0);
});


test('a path given that does not exist is a finding, whatever else is valid', () => {
	expect(run([join(dir, 'missing.neon'), '-'], 'a: 1')).toEqual({ code: 1, out: '<dir>/missing.neon: No file found\n', err: '' });
	expect(run([join(dir, 'valid.neon'), join(dir, 'missing.neon')]).code).toBe(1);
});


test('one file under two paths is linted once, the files in the order of their paths', () => {
	const twice = run(['--verbose', join(dir, 'valid.neon'), join(dir, 'sub', '..', 'valid.neon')]);
	expect(twice).toEqual({ code: 0, out: 'OK 1 files\n', err: '' });
	expect(run([join(dir, 'sub'), join(dir, 'invalid.neon')]).out).toBe('<dir>/invalid.neon:2:3: Bad indentation\n<dir>/sub/utf8.neon:1:4: Invalid UTF-8 sequence.\n');
});
