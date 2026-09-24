import { describe, expect, test } from 'vitest';
import { dump } from '../src/dumper.ts';
import { NeonError } from '../src/errors.ts';
import { parse } from '../src/parser.ts';
import { decodeUtf8 } from '../src/utf8.ts';
import { loadCases, runsHere } from './corpus.ts';
import { equal, toHost, type Typed } from './typed.ts';


const error = (bytes: Buffer): string => {
	try {
		parse(decodeUtf8(bytes)).toValue();
	} catch (e) {
		if (e instanceof NeonError) {
			return `${e.message}\n${e.position?.line}:${e.position?.column}\n`;
		}
		throw e;
	}
	return 'accepted';
};


describe('decode', () => {
	test.each(loadCases('decode').filter(runsHere).map((c) => [c.name, c]))('%s', (_, c) => {
		const input = c.read('.neon')!;
		const expected = c.read('.json');
		expect(expected, 'expectation').not.toBeNull();
		const document = parse(input);
		expect(document.print()).toBe(input);
		const actual = document.toValue();
		const host = toHost(JSON.parse(expected!) as Typed);
		expect(equal(actual, host), JSON.stringify([actual, host], (_, v) => typeof v === 'bigint' ? v + 'n' : v)).toBe(true);
	});
});


describe('errors', () => {
	test.each(loadCases('errors').filter(runsHere).map((c) => [c.name, c]))('%s', (_, c) => {
		const expected = c.read('.error');
		expect(expected, 'expectation').not.toBeNull();
		expect(error(c.readBytes('.neon')!)).toBe(expected);
	});
});


describe('cst', () => {
	test.each(loadCases('cst').filter(runsHere).map((c) => [c.name, c]))('%s', (_, c) => {
		const input = c.read('.neon')!;
		const document = parse(input);
		expect(document.print()).toBe(input);
		expect(dump(document)).toBe(c.read('.dump'));
	});
});


describe('roundtrip', () => {
	test.each(loadCases('roundtrip').filter(runsHere).map((c) => [c.name, c]))('%s', (_, c) => {
		const input = c.read('.neon')!;
		const document = parse(input);
		expect(document.print()).toBe(input);
		document.toValue();
		expect(dump(document)).toBe(c.read('.dump'));
	});
});
