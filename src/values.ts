/** Value of the neutral model mapped to JavaScript. */
export type NeonValue
	= | null
		| boolean
		| number
		| bigint
		| string
		| NeonDate
		| Entity
		| NeonValue[]
		| { [key: string]: NeonValue };


/** The value of an entity, `value(attributes)`; a chain is an entity whose value is Chain. */
export class Entity {
	constructor(
		public value: NeonValue,
		public attributes: NeonValue[] | { [key: string]: NeonValue } = [],
	) {
	}
}


/** The value of an entity that represents a chain; its attributes are the links. */
export const Chain = '!!chain';


/** A date as written: components and an offset, or none for a local date. */
export class NeonDate {
	constructor(
		readonly year: number,
		readonly month: number,
		readonly day: number,
		readonly hour: number | null = null,
		readonly minute: number | null = null,
		readonly second: number | null = null,
		/** Digits of the fraction of a second as written, without the point. */
		readonly fraction: string | null = null,
		/** `+HH:MM` or `-HH:MM`, or null for a local date. */
		readonly offset: string | null = null,
	) {
		const time = [hour, minute, second];
		if (!inRange(year, 0, 9999) || !inRange(month, 1, 12) || !inRange(day, 1, daysInMonth(year, month))
			|| (hour === null
				? time.some((n) => n !== null) || fraction !== null || offset !== null
				: !inRange(hour, 0, 23) || !inRange(minute, 0, 59) || !inRange(second, 0, 59))
			|| (fraction !== null && !/^\d+$/.test(fraction))
			|| (offset !== null && !/^[-+](?:(?:0\d|1[0-3]):[0-5]\d|14:00)$/.test(offset))
		) {
			throw new RangeError('A component of the date is out of range.');
		}
		Object.freeze(this);
	}


	/** An instant as a date in UTC. */
	static fromDate(date: Date): NeonDate {
		const ms = date.getUTCMilliseconds();
		return new NeonDate(
			date.getUTCFullYear(),
			date.getUTCMonth() + 1,
			date.getUTCDate(),
			date.getUTCHours(),
			date.getUTCMinutes(),
			date.getUTCSeconds(),
			ms ? String(ms).padStart(3, '0').replace(/0+$/, '') : null,
			'+00:00',
		);
	}


	/** Parses the text of a date literal; null if the text is not one, its components making no valid date included. */
	static parse(text: string): NeonDate | null {
		const m = DatePattern.exec(text);
		if (!m) {
			return null;
		}

		const [, year, month, day, hour, minute, second, fraction, zone] = m;
		const num = (s: string | undefined) => s === undefined ? null : Number(s);
		let offset: string | null = null;
		if (zone === 'Z') {
			offset = '+00:00';
		} else if (zone) {
			const z = /^([-+])(\d\d?)(?::?(\d\d))?$/.exec(zone)!;
			offset = z[1] + z[2]!.padStart(2, '0') + ':' + (z[3] ?? '00');
		}

		try {
			return new NeonDate(Number(year), Number(month), Number(day), num(hour), num(minute), num(second), fraction || null, offset);
		} catch (e) {
			if (e instanceof RangeError) {
				return null;
			}
			throw e;
		}
	}


	/** Converts the date to an instant; a local date needs the time zone offset in minutes or 'UTC'. */
	toDate(zone?: 'UTC' | number): Date {
		let offset: number;
		if (this.offset) {
			const sign = this.offset[0] === '-' ? -1 : 1;
			offset = sign * (Number(this.offset.slice(1, 3)) * 60 + Number(this.offset.slice(4, 6)));
		} else if (zone === undefined) {
			throw new TypeError('A local date needs a time zone to become an instant.');
		} else {
			offset = zone === 'UTC' ? 0 : zone;
		}

		const ms = Number((this.fraction ?? '').padEnd(3, '0').slice(0, 3));
		const res = new Date(0);
		res.setUTCFullYear(this.year, this.month - 1, this.day); // Date.UTC() would map years 0-99 to 1900-1999
		res.setUTCHours(this.hour ?? 0, (this.minute ?? 0) - offset, this.second ?? 0, ms);
		return res;
	}


	/** The date as the encoder writes it, without the fraction of a second. */
	toString(): string {
		const pad = (n: number, width = 2) => String(n).padStart(width, '0');
		let res = `${pad(this.year, 4)}-${pad(this.month)}-${pad(this.day)}`;
		if (this.hour !== null) {
			res += ` ${pad(this.hour)}:${pad(this.minute!)}:${pad(this.second!)}`;
		}
		if (this.offset) {
			res += ' ' + this.offset.replace(':', '');
		}
		return res;
	}


	/** Equality of components, including the presence of an offset and the written fraction. */
	equals(other: NeonDate): boolean {
		return this.year === other.year && this.month === other.month && this.day === other.day
			&& this.hour === other.hour && this.minute === other.minute && this.second === other.second
			&& this.fraction === other.fraction && this.offset === other.offset;
	}
}


function daysInMonth(year: number, month: number): number {
	return month === 2
		? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
		: [4, 6, 9, 11].includes(month) ? 30 : 31;
}


function inRange(n: number | null, min: number, max: number): boolean {
	return Number.isInteger(n) && n! >= min && n! <= max;
}


/**
 * Equality of values between a value of the host and a decoded one. A number and a bigint of the
 * same integer are equal; a plain object does not keep the order of integer-like keys, so with one the
 * order does not count.
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
	if (typeof b === 'number' || typeof b === 'bigint') {
		if (typeof a === 'number' && typeof b === 'number') {
			return a === b || (Number.isNaN(a) && Number.isNaN(b));
		}
		const [n, big] = typeof a === 'number' ? [a, b] : [b, a];
		return typeof n === 'number' ? typeof big === 'bigint' && Number.isInteger(n) && BigInt(n) === big : n === big;
	} else if (b instanceof NeonDate) {
		let date = a;
		try {
			date = a instanceof Date ? NeonDate.fromDate(a) : a;
		} catch {
			// a Date out of the range of the model equals no date
		}
		return date instanceof NeonDate && b.equals(date);
	} else if (b instanceof Entity) {
		return a instanceof Entity && valuesEqual(a.value, b.value) && valuesEqual(a.attributes, b.attributes);
	} else if (typeof b === 'object' && b !== null) {
		const x = entriesOf(a);
		const y = entriesOf(b);
		if (!x || !y || x.list !== y.list || x.entries.length !== y.entries.length) {
			return false;
		} else if (x.ordered && y.ordered) {
			return x.entries.every(([key, v], i) => y.entries[i]![0] === key && valuesEqual(v, y.entries[i]![1]));
		}
		const map = new Map(y.entries);
		return x.entries.every(([key, v]) => map.has(key) && valuesEqual(v, map.get(key)));
	}
	return a === b;
}


/** Entries of an array of the host with canonical keys, whether they make a list, and whether their order is kept. */
export function entriesOf(value: unknown): { entries: [string, unknown][]; list: boolean; ordered: boolean } | null {
	let entries: [string, unknown][];
	if (Array.isArray(value)) {
		return { entries: value.map((v, i) => [String(i), v]), list: true, ordered: true };
	} else if (value instanceof Map) {
		entries = [...value].map(([key, v]) => [String(key), v]);
	} else if (typeof value === 'object' && value !== null && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
		entries = Object.entries(value);
	} else {
		return null;
	}
	return { entries, list: entries.length > 0 && entries.every(([key], i) => key === String(i)), ordered: value instanceof Map };
}


const DatePattern = /^(\d{4})-(\d\d?)-(\d\d?)(?:(?:[Tt]| +)(\d\d?):(\d\d):(\d\d)(?:\.(\d*))? *(Z|[-+]\d\d?(?::?\d\d)?)?)?$/;

const SimpleTypes: Record<string, boolean | null> = {
	true: true, True: true, TRUE: true, yes: true, Yes: true, YES: true,
	false: false, False: false, FALSE: false, no: false, No: false, NO: false,
	null: null, Null: null, NULL: null,
};

const DecimalPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const IntegerPattern = /^[+-]?\d+$/;
const BasePattern = /^0(?:x[0-9a-fA-F]+|o[0-7]+|b[01]+)$/;

const MaxSafe = BigInt(Number.MAX_SAFE_INTEGER);
const Int64Max = 2n ** 63n - 1n;
const Int64Min = -(2n ** 63n);


/** A number literal as a number or a bigint, or undefined if the text is not a number. */
export function evaluateNumber(text: string): number | bigint | undefined {
	if (IntegerPattern.test(text) || BasePattern.test(text)) {
		return integer(BigInt(text.replace(/^\+/, '')));
	} else if (DecimalPattern.test(text)) {
		return Number(text);
	}
	return undefined;
}


/** Value of a literal that is not a key. */
export function evaluateLiteral(text: string): NeonValue {
	if (Object.hasOwn(SimpleTypes, text)) {
		return SimpleTypes[text]!;
	}
	return evaluateNumber(text) ?? NeonDate.parse(text) ?? text;
}


/** Canonical key of a key literal or a string key. */
export function canonicalKey(value: string | number | bigint, isFloat = false): string {
	if (typeof value === 'string') {
		return value;
	} else if (typeof value === 'bigint' || (!isFloat && Number.isInteger(value))) {
		return String(BigInt(value));
	}
	return floatKey(value);
}


/** Canonical key of a literal written as a key. */
export function literalKey(text: string): string {
	const num = evaluateNumber(text);
	if (num === undefined) {
		return text;
	}
	return canonicalKey(num, typeof num === 'number' && !IntegerPattern.test(text) && !BasePattern.test(text));
}


/** A float as PHP converts it to a string: 14 significant digits. */
function floatKey(f: number): string {
	if (Number.isNaN(f)) {
		return 'NAN';
	} else if (!Number.isFinite(f)) {
		return f > 0 ? 'INF' : '-INF';
	} else if (f === 0) {
		return Object.is(f, -0) ? '-0' : '0';
	}

	const [mantissa, exponent] = f.toExponential(13).split('e') as [string, string];
	const e = Number(exponent);
	if (e >= -4 && e < 14) { // toPrecision() is positional in this range
		const digits = f.toPrecision(14);
		return digits.includes('.') ? digits.replace(/\.?0+$/, '') : digits;
	}
	let m = mantissa.replace(/0+$/, '').replace(/\.$/, '');
	if (!m.includes('.')) {
		m += '.0';
	}
	return `${m}E${e < 0 ? '-' : '+'}${Math.abs(e)}`;
}


/** Whether a canonical key is an integer key: what PHP converts to an integer array key. */
export function isIntegerKey(key: string): boolean {
	if (!/^(?:0|-?[1-9]\d*)$/.test(key)) {
		return false;
	}
	const n = BigInt(key);
	return n >= Int64Min && n <= Int64Max;
}


export { Int64Max };


/** How deep arrays nest (a block, an inline array and attributes each count as one level). */
export const MaxDepth = 500;


function integer(n: bigint): number | bigint {
	return n <= MaxSafe && n >= -MaxSafe ? Number(n) : n;
}


const Escapes: Record<string, string> = {
	't': '\t', 'n': '\n', 'r': '\r', 'f': '\f', 'b': '\b', '"': '"', '\\': '\\', '/': '/', '_': String.fromCharCode(0xA0),
};


/** Value of a string token. Throws EscapeError for an invalid escape sequence. */
export function evaluateString(text: string): string {
	text = text.replaceAll('\r', '');
	let res: string;
	const multiline = /^('''|""")\n/.test(text);
	if (multiline) {
		const indent = /^...\n+([\t ]*)/.exec(text)![1]!;
		res = text.slice(3, -3);
		if (indent !== '') {
			res = res.replaceAll('\n' + indent, '\n');
		}
		res = res.replace(/^\n/, '').replace(/\n[\t ]*$/, '');
	} else {
		res = text.slice(1, -1);
		if (text[0] === '\'') {
			res = res.replaceAll('\'\'', '\'');
		}
	}

	if (text[0] === '\'') {
		return res;
	}

	// the pattern of nette/neon 3.x, case-insensitive, so \U0041 and \uD801\UDC01 are one sequence each
	return res.replace(/\\(?:ud[89ab][0-9a-f]{2}\\ud[c-f][0-9a-f]{2}|u[0-9a-f]{4}|[^\n])/gi, (seq) => {
		const c = seq[1]!;
		if (Object.hasOwn(Escapes, c)) {
			return Escapes[c]!;
		} else if (c !== 'u' || seq.length < 6) {
			throw new EscapeError(`Invalid escaping sequence ${seq}`);
		} else if (seq.length === 12) {
			if (seq[7] !== 'u') {
				throw new EscapeError(`Invalid UTF-8 sequence ${seq}`);
			}
			return String.fromCharCode(parseInt(seq.slice(2, 6), 16), parseInt(seq.slice(8), 16));
		}
		const code = parseInt(seq.slice(2), 16);
		if (code >= 0xD800 && code <= 0xDFFF) {
			throw new EscapeError(`Invalid UTF-8 sequence ${seq}`);
		}
		return String.fromCharCode(code);
	});
}


/** An invalid escape sequence; the parser reports it at the position of the string. */
export class EscapeError extends Error {
}
