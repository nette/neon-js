import { Chain, Entity, NeonDate, type NeonValue } from '../src/values.ts';


/** Typed value of the corpus. */
export type Typed
	= | { type: 'null' }
		| { type: 'bool'; value: boolean }
		| { type: 'int'; value: string }
		| { type: 'float'; value: string }
		| { type: 'string'; value: string }
		| { type: 'date'; value: string }
		| { type: 'entity'; value: Typed; attributes: Typed }
		| { type: 'chain'; entities: Typed[] }
		| { type: 'list'; items: Typed[] }
		| { type: 'map'; entries: [string, Typed][] };


/** The JavaScript value of a typed value. */
export function toHost(typed: Typed): NeonValue {
	switch (typed.type) {
		case 'null':
			return null;
		case 'bool':
		case 'string':
			return typed.value;
		case 'int': {
			const n = BigInt(typed.value);
			return n <= BigInt(Number.MAX_SAFE_INTEGER) && n >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
		}
		case 'float':
			return { 'INF': Infinity, '-INF': -Infinity, 'NAN': NaN }[typed.value] ?? Number(typed.value);
		case 'date': {
			const date = NeonDate.parse(typed.value);
			if (!date) {
				throw new RangeError(`Invalid date ${typed.value}`);
			}
			return date;
		}
		case 'entity':
			return new Entity(toHost(typed.value), toHost(typed.attributes) as Entity['attributes']);
		case 'chain':
			return new Entity(Chain, typed.entities.map(toHost));
		case 'list':
			return typed.items.map(toHost);
		case 'map': {
			if (typed.entries.length && typed.entries.every(([key], i) => key === String(i))) {
				throw new Error('A map with keys 0..n-1 must be written as a list.');
			}
			const res: { [key: string]: NeonValue } = {};
			for (const [key, value] of typed.entries) {
				Object.defineProperty(res, key, { value: toHost(value), writable: true, enumerable: true, configurable: true });
			}
			return res;
		}
		default:
			throw new Error(`Unknown type ${(typed as { type: string }).type}`);
	}
}


/** The value to encode: like toHost(), but a map is a Map, which keeps the order of its keys. */
export function toEncodable(typed: Typed): unknown {
	switch (typed.type) {
		case 'map':
			return new Map(typed.entries.map(([key, value]) => [key, toEncodable(value)]));
		case 'list':
			return typed.items.map(toEncodable);
		case 'entity':
			return new Entity(toEncodable(typed.value) as NeonValue, toEncodable(typed.attributes) as Entity['attributes']);
		case 'chain':
			return new Entity(Chain, typed.entities.map(toEncodable) as NeonValue[]);
		default:
			return toHost(typed);
	}
}


/**
 * Equality of values as far as JavaScript can tell: an integral float is a number like an
 * integer (the deviation of the host), so 1 and 1.0 are equal here.
 */
export function equal(a: unknown, b: unknown): boolean {
	if (typeof a === 'number' && typeof b === 'number') {
		return Object.is(a, b) || (a === b) || (Number.isNaN(a) && Number.isNaN(b));
	} else if (a instanceof NeonDate && b instanceof NeonDate) {
		return a.equals(b);
	} else if (a instanceof Entity && b instanceof Entity) {
		return equal(a.value, b.value) && equal(a.attributes, b.attributes);
	} else if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((v, i) => equal(v, b[i]));
	} else if (isPlainObject(a) && isPlainObject(b)) {
		const ka = Object.keys(a);
		const kb = Object.keys(b);
		return ka.length === kb.length && ka.every((k, i) => k === kb[i] && equal(a[k], b[k]));
	}
	return a === b;
}


function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Entity) && !(v instanceof NeonDate);
}
