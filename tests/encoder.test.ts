import { expect, test } from 'vitest';
import { decode, encode, Neon } from '../src/neon.ts';
import { Chain, Entity, NeonDate } from '../src/values.ts';
import { equal } from './typed.ts';


test('values of the host', () => {
	expect(encode(new Map<string | number, unknown>([[2, 'a'], ['x', 1], [1, 'b']]))).toBe('{2: a, x: 1, 1: b}');
	expect(encode({ a: 1, b: [1, 2] })).toBe('{a: 1, b: [1, 2]}');
	expect(encode({})).toBe('{}');
	expect(encode((new Map), true)).toBe('{}');
	expect(encode([], true)).toBe('[]');
	expect(encode(12345678901234567890n)).toBe('12345678901234567890');
	expect(encode(1.0)).toBe('1');
	expect(encode(-0)).toBe('-0.0');
	expect(encode(0.1)).toBe('0.1');
	expect(encode(new Date(Date.UTC(2016, 5, 3, 19, 0, 0, 500)))).toBe('2016-06-03 19:00:00 +0000');
	expect(encode(new NeonDate(2016, 6, 3, 19, 0, 0, '5', '+02:00'))).toBe('2016-06-03 19:00:00 +0200');
	expect(encode(new NeonDate(2016, 6, 3))).toBe('2016-06-03');
	expect(encode(new Entity('Foo', { a: 1 }))).toBe('Foo(a: 1)');
	expect(encode(new Entity(Chain, [new Entity('a', []), new Entity('b', [1])]))).toBe('a()b(1)');
	expect(Neon.encode({ a: { b: 1 } }, true, '  ')).toBe('a:\n  b: 1\n\n');
});


test('blocks chosen by a function', () => {
	const value = { roles: ['guest', 'member'], mail: { host: 'smtp', ports: [25, 587] }, deep: { a: { b: [1] } } };
	expect(encode(value, (_, path) => !path.length)).toBe('roles: [guest, member]\nmail: {host: smtp, ports: [25, 587]}\ndeep: {a: {b: [1]}}\n');
	expect(encode(value, (_, path) => path.length < 2)).toBe('roles:\n\t- guest\n\t- member\n\nmail:\n\thost: smtp\n\tports: [25, 587]\n\ndeep:\n\ta: {b: [1]}\n\n');
	const long = (v: unknown) => !Array.isArray(v) || v.length > 3;
	expect(encode(value, long)).toBe('roles: [guest, member]\nmail:\n\thost: smtp\n\tports: [25, 587]\n\ndeep:\n\ta:\n\t\tb: [1]\n\n');
	const paths: string[] = [];
	encode(value, (_, path) => paths.push(path.join('.')) > 0);
	expect(paths).toEqual(['', 'roles', 'mail', 'mail.ports', 'deep', 'deep.a', 'deep.a.b']);
});


test('values that cannot be encoded', () => {
	expect(() => encode(undefined)).toThrow('undefined cannot be encoded');
	expect(() => encode({ a: [1, () => 1] })).toThrow('function cannot be encoded at a.1');
	expect(() => encode(Symbol('x'))).toThrow('symbol cannot be encoded');
	expect(() => encode((new (class Foo {})))).toThrow('an instance of Foo cannot be encoded');
	expect(() => encode([1, , 3])).toThrow('sparse array cannot be encoded at 1'); // eslint-disable-line no-sparse-arrays
	expect(() => encode(Infinity)).toThrow('INF and NAN cannot be encoded to NEON');
	expect(() => encode('\uD800')).toThrow('lone surrogate');
	const cycle: Record<string, unknown> = {};
	cycle.self = { cycle };
	expect(() => encode(cycle)).toThrow('cycle cannot be encoded at self.cycle');
});


test('values whose text would decode as another value', () => {
	const entity = new Entity('a');
	entity.value = entity;
	expect(() => encode(entity)).toThrow('cycle');
	const attributes: unknown[] = [];
	attributes.push(new Entity('b', attributes as Entity['attributes']));
	expect(() => encode(attributes)).toThrow('cycle');
	const shared = new Entity('x');
	expect(encode([shared, shared])).toBe('[x(), x()]');

	expect(() => encode(new Map<string | number, string>([[1, 'a'], ['1', 'b']]))).toThrow('twice');
	expect(() => encode(new Entity(Chain, [new Entity('a')]))).toThrow('two or more');
	expect(() => encode(new Entity(Chain, []))).toThrow('two or more');
	expect(() => encode(new Entity(Chain, [new Entity('a'), new Entity('1x')]))).toThrow('literal');
	expect(() => encode(new Entity(new Entity('a')))).toThrow('entity or a chain');
	expect(encode(new Entity(Chain, [new Entity('a'), new Entity(5)]))).toBe('a()5()');

	expect(() => new NeonDate(2024, 99, 1)).toThrow(RangeError);
	expect(() => new NeonDate(2024, 1, 1, 12)).toThrow(RangeError);
	expect(() => new NeonDate(2024, 1, 1, null, null, null, null, '+01:00')).toThrow(RangeError);
	expect(() => new NeonDate(2024, 1, 1, 1, 2, 3, '5x')).toThrow(RangeError);
	expect(() => new NeonDate(10000, 1, 1)).toThrow(RangeError);
	expect(() => new NeonDate(2024, 2, 30)).toThrow(RangeError);
	expect(decode('2024-02-30')).toBe('2024-02-30');
	expect(decode(encode('2024-02-30'))).toBe('2024-02-30');
	expect(() => encode(new Date(Date.UTC(10000, 0, 1)))).toThrow('out of the years');
});


test('arrays nest at most 500 levels, in the parser and in the encoder', () => {
	const nested = (n: number): unknown => n ? [nested(n - 1)] : 'x';
	expect(decode(encode(nested(500)))).toEqual(nested(500));
	expect(() => encode(nested(501))).toThrow('nested deeper than 500');
	expect(() => encode(new Entity('e', nested(501) as Entity['attributes']))).toThrow('nested deeper than 500');
	expect(() => decode('['.repeat(5000))).toThrow('Too deep nesting');

	const start = performance.now(); // a block on the line of a dash is not tried with both indentations
	expect(() => decode('- '.repeat(40) + 'x\n  {')).toThrow('Unexpected end');
	expect(performance.now() - start).toBeLessThan(1000);
});


test('options', () => {
	expect(() => encode({ a: { b: 1 } }, { blockMode: true, indentation: 'x' })).toThrow('indentation');
	expect(() => encode({ a: { b: 1 } }, { blockMode: true, indentation: '' })).toThrow('indentation');
	for (const blockMode of [1, 'yes']) {
		expect(() => encode([], { blockMode: blockMode as never })).toThrow('blockMode');
	}
	const asked: unknown[] = [];
	encode('scalar', (value) => asked.push(value) > 0);
	expect(asked).toEqual([]);
});


test('__proto__ and other special keys survive the round trip', () => {
	const value = decode('{__proto__: 1, constructor: 2, hasOwnProperty: 3}');
	expect(encode(value)).toBe('{__proto__: 1, constructor: 2, hasOwnProperty: 3}');
});


/** A small deterministic generator, so that a failure is reproducible by its seed. */
function random(seed: number): () => number {
	return () => {
		seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF;
		return seed / 0x80000000;
	};
}


const Strings = ['', 'a', 'a b', ' a', 'a ', 'true', 'On', '-', '-.5', '+.5', ':', 'a:b', '#', 'a #b', '1', '0x1F', '2016-06-03', '\'', '"', '\\', 'ž', '\t', 'a\nb', '  a\nb', '\na', 'a\n', '\'\'\'\nx', 'x\n\'\'\'', 'a\r\nb', '\u0001', 'é\u2028'];


function generate(next: () => number, depth: number): unknown {
	const pick = <T>(list: T[]): T => list[Math.floor(next() * list.length)]!;
	switch (Math.floor(next() * (depth > 0 ? 10 : 6))) {
		case 0: return pick([null, true, false]);
		case 1: return Math.floor(next() * 2000) - 1000;
		case 2: return pick([0.5, -1.25, 1e-7, 1.5e300, 0.1 + 0.2, -0]);
		case 3: return pick([2n ** 64n, -(2n ** 70n)]);
		case 4: return pick(Strings);
		case 5: return pick([new NeonDate(2016, 6, 3, 19, 0, 0, null, '+02:00'), new NeonDate(2016, 6, 3)]);
		case 6:
		case 7: return Array.from({ length: Math.floor(next() * 4) }, () => generate(next, depth - 1));
		case 8: return Object.fromEntries(Array.from({ length: Math.floor(next() * 4) }, () => [pick(Strings), generate(next, depth - 1)]));
		default: return new Entity(pick(['Foo', 'a b', '@x']), Array.from({ length: Math.floor(next() * 3) }, () => generate(next, depth - 1)) as never);
	}
}


test('decode(encode(v)) equals v', () => {
	for (let seed = 1; seed <= 3000; seed++) {
		const value = generate(random(seed), 3);
		for (const blockMode of [false, true]) {
			const text = encode(value, blockMode, seed % 2 ? '\t' : '  ');
			const back = decode(text);
			expect(equal(back, normalize(value)), `seed ${seed}, block ${blockMode}: ${text}`).toBe(true);
		}
	}
});


/** What decoding gives back in JavaScript: an object with keys 0..n-1 is a list. */
function normalize(value: unknown): unknown {
	if (value instanceof Entity) {
		return new Entity(normalize(value.value) as never, normalize(value.attributes) as never);
	} else if (Array.isArray(value)) {
		return value.map(normalize);
	} else if (value && typeof value === 'object' && !(value instanceof NeonDate)) {
		const entries = Object.entries(value);
		if (entries.length && entries.every(([key], i) => key === String(i))) {
			return entries.map(([, v]) => normalize(v));
		}
		return Object.fromEntries(entries.map(([key, v]) => [key, normalize(v)]));
	} else if (typeof value === 'bigint' && value >= -BigInt(Number.MAX_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
		return Number(value);
	}
	return value;
}
