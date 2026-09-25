import { NeonError } from './errors.ts';
import { Scanner } from './scanner.ts';
import { Chain, Entity, evaluateLiteral, isIntegerKey, MaxDepth, NeonDate } from './values.ts';


export interface EncodeOptions {
	/** Writes arrays as blocks, one item per line; a function is asked for every array, with the keys to it. */
	blockMode?: boolean | BlockFilter;
	/** Indentation of nested blocks and of the lines of multiline strings. */
	indentation?: string;
	/** @internal Writes multiline strings in """, for a document where ''' would close an earlier string. */
	doubleQuotedMultiline?: boolean;
}


/** Decides whether the array is written as a block. */
export type BlockFilter = (value: unknown, path: readonly string[]) => boolean;


/** Writes a value as NEON. */
export function encode(value: unknown, options: EncodeOptions = {}): string {
	return new Encoder(options).encode(value);
}


type Entries = [key: string, value: unknown][];


class Encoder {
	readonly #stack: unknown[] = [];
	readonly #arrays: unknown[] = [];
	readonly #path: string[] = [];
	private readonly indentation: string;
	private readonly doubleQuoted: boolean;
	private readonly blockMode: boolean | BlockFilter;


	constructor(options: EncodeOptions) {
		this.indentation = options.indentation ?? '\t';
		this.doubleQuoted = options.doubleQuotedMultiline ?? false;
		this.blockMode = options.blockMode ?? false;
		if (typeof this.indentation !== 'string' || !/^[\t ]+$/.test(this.indentation)) {
			throw new TypeError('The indentation is a non-empty run of spaces and tabs.');
		} else if (typeof this.blockMode !== 'boolean' && typeof this.blockMode !== 'function') {
			throw new TypeError('The blockMode is a boolean or a function.');
		}
	}


	encode(value: unknown): string {
		const entries = this.entries(value);
		if (!entries || !this.isBlock(value)) {
			return this.inline(value);
		} else if (!entries.length) {
			return isMapLike(value) ? '{}' : '[]';
		}
		return this.block(value, entries);
	}


	private block(container: unknown, entries: Entries): string {
		let res = '';
		this.enter(container, true);
		for (const [key, value, hidden] of withHiddenKeys(entries)) {
			this.#path.push(key);
			const prefix = hidden ? '-' : this.key(key) + ':';
			const nested = this.entries(value);
			if (nested?.length && this.isBlock(value)) {
				const text = indent(this.block(value, nested), this.indentation);
				res += prefix + '\n' + text + (text.endsWith('\n\n') ? '' : '\n');
			} else {
				res += prefix + ' ' + this.inline(value) + '\n';
			}
			this.#path.pop();
		}
		this.leave();
		return res;
	}


	private isBlock(value: unknown): boolean {
		return typeof this.blockMode === 'function' ? this.blockMode(value, [...this.#path]) : this.blockMode;
	}


	private inline(value: unknown): string {
		if (value instanceof Entity) {
			this.enter(value);
			const res = value.value === Chain ? this.chain(value) : this.entity(value);
			this.leave();
			return res;
		}

		const entries = this.entries(value);
		if (entries) {
			const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
			return open + this.items(value) + close;
		}
		return this.scalar(value);
	}


	private entity(entity: Entity, link = false): string {
		const head = this.inline(entity.value);
		if (entity.value instanceof Entity) {
			this.fail('the value of an entity cannot be an entity or a chain');
		} else if (link && /^['"[{]/.test(head)) {
			this.fail('a link of a chain after the first needs a head written as a literal');
		}
		return head + '(' + this.items(entity.attributes) + ')';
	}


	private chain(chain: Entity): string {
		const links = chain.attributes;
		if (!Array.isArray(links) || links.length < 2 || !links.every((link) => link instanceof Entity && link.value !== Chain)) {
			this.fail('a chain must hold a list of two or more entities');
		}
		return links.map((link, i) => {
			this.enter(link);
			const res = this.entity(link as Entity, i > 0);
			this.leave();
			return res;
		}).join('');
	}


	private items(container: unknown): string {
		this.enter(container, true);
		const res = withHiddenKeys(this.entries(container) ?? this.fail('attributes must be an array or an object'))
			.map(([key, value, hidden]) => {
				this.#path.push(key);
				const text = (hidden ? '' : this.key(key) + ': ') + this.inline(value);
				this.#path.pop();
				return text;
			})
			.join(', ');
		this.leave();
		return res;
	}


	private key(key: string): string {
		return isIntegerKey(key) ? key : this.string(key);
	}


	private scalar(value: unknown): string {
		if (value === null) {
			return 'null';
		} else if (typeof value === 'boolean') {
			return String(value);
		} else if (typeof value === 'bigint') {
			return value.toString();
		} else if (typeof value === 'number') {
			return Number.isSafeInteger(value) && !Object.is(value, -0)
				? String(value) // cannot be told from an integer; beyond 2^53 a number is a float, integers are bigint
				: formatFloat(value) ?? this.fail('INF and NAN cannot be encoded to NEON', false);
		} else if (typeof value === 'string') {
			if (!value.isWellFormed()) {
				this.fail('a string with a lone surrogate');
			}
			return this.string(value);
		} else if (value instanceof NeonDate) {
			return value.toString();
		} else if (value instanceof Date) {
			return formatDate(value);
		}
		this.fail(`${typeof value === 'object' ? 'an instance of ' + (value as object).constructor?.name : typeof value} cannot be encoded`);
	}


	private string(s: string): string {
		if (s.includes('\n')) {
			return this.multiline(s);
		} else if (!needsQuotes(s)) {
			return s;
		} else if (/[\x00-\x08\x0B-\x1F]/.test(s)) { // eslint-disable-line no-control-regex
			return jsonString(s);
		}
		return '\'' + s.replaceAll('\'', '\'\'') + '\'';
	}


	private multiline(s: string): string {
		let delimiter = '\'\'\'';
		let content = s;
		const firstLine = /^\n*([^\n]*)/.exec(s)![1]!;
		if (this.doubleQuoted || /[\x00-\x08\x0B-\x1F]/.test(s) || /(?:^|\n)[\t ]*'''/.test(s) || /^[\t ]/.test(firstLine)) { // eslint-disable-line no-control-regex
			delimiter = '"""';
			content = jsonString(s).slice(1, -1)
				.replace(/\\(.)/g, (seq, c: string) => ({ 'n': '\n', 't': '\t', '"': '"' })[c] ?? seq)
				.replaceAll('"""', '""\\"')
				.replace(/^(\n*)([\t ]+)/, (_, newlines: string, space: string) => newlines + space.replaceAll(' ', '\\u0020').replaceAll('\t', '\\t'));
		}
		return delimiter + '\n' + indent(content, this.indentation) + '\n' + delimiter;
	}


	/** Entries of an array, a Map or a plain object; null for anything else. */
	private entries(value: unknown): Entries | null {
		if (Array.isArray(value)) {
			const res: Entries = [];
			for (let i = 0; i < value.length; i++) {
				if (!(i in value)) {
					this.#path.push(String(i));
					this.fail('a sparse array cannot be encoded');
				}
				res.push([String(i), value[i]]);
			}
			return res;
		} else if (value instanceof Map) {
			const keys = (new Set<string>);
			return [...value].map(([key, v]): [string, unknown] => {
				if (typeof key !== 'string' && typeof key !== 'number') {
					this.fail('a key of a Map must be a string or a number');
				} else if (keys.has(String(key))) {
					this.fail(`the keys of a Map give the key '${String(key)}' twice`);
				}
				keys.add(String(key));
				return [String(key), v];
			});
		} else if (isPlainObject(value)) {
			return Object.keys(value).map((key) => [key, (value as Record<string, unknown>)[key]]);
		}
		return null;
	}


	/** Goes into a container, an array being one level of nesting. */
	private enter(container: unknown, array = false): void {
		if (this.#stack.includes(container)) {
			this.fail('a cycle cannot be encoded');
		} else if (array && this.#arrays.length >= MaxDepth) {
			this.fail(`arrays nested deeper than ${MaxDepth} levels`);
		}
		this.#stack.push(container);
		if (array) {
			this.#arrays.push(container);
		}
	}


	private leave(): void {
		if (this.#arrays.at(-1) === this.#stack.pop()) {
			this.#arrays.pop();
		}
	}


	private fail(reason: string, withPath = true): never {
		const at = withPath && this.#path.length ? ` at ${this.#path.join('.')}` : '';
		throw new NeonError(withPath ? `Cannot encode: ${reason}${at}` : reason);
	}
}


/** Marks the keys that decoding would assign anyway. */
function withHiddenKeys(entries: Entries): [string, unknown, boolean][] {
	let counter = 0n;
	let hiding = true;
	return entries.map(([key, value]) => {
		const integer = isIntegerKey(key);
		const hidden = hiding && integer && BigInt(key) === counter;
		if (integer && hiding) {
			const k = BigInt(key);
			hiding = k === counter;
			counter = k + 1n > counter ? k + 1n : counter;
		}
		return [key, value, hidden];
	});
}


/** Whether the string has to be quoted. */
export function needsQuotes(s: string): boolean {
	const token = new Scanner(s).next();
	return !token || token.kind !== 'Literal' || token.end !== s.length
		|| /[\x00-\x1F]/.test(s) // eslint-disable-line no-control-regex
		|| /^[+\-.]?\d/.test(s)
		|| /^(?:true|false|yes|no|on|off|null)$/i.test(s)
		|| evaluateLiteral(s) !== s;
}


function jsonString(s: string): string {
	return JSON.stringify(s).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}


/** Shortest round-trip digits, positional for exponents -4 to 16; null for INF and NAN. */
export function formatFloat(f: number): string | null {
	if (!Number.isFinite(f)) {
		return null;
	} else if (f === 0) {
		return Object.is(f, -0) ? '-0.0' : '0.0';
	}

	const [mantissa, exponent] = Math.abs(f).toExponential().split('e') as [string, string];
	const digits = mantissa.replace('.', '');
	const e = Number(exponent);
	const sign = f < 0 ? '-' : '';
	if (e >= -4 && e < 17) {
		if (e < 0) {
			return sign + '0.' + '0'.repeat(-e - 1) + digits;
		}
		const whole = digits.slice(0, e + 1).padEnd(e + 1, '0');
		const fraction = digits.slice(e + 1);
		return sign + whole + '.' + (fraction || '0');
	}
	return sign + (mantissa.includes('.') ? mantissa : mantissa + '.0') + 'e' + (e < 0 ? '-' : '+') + Math.abs(e);
}


/** An instant, written in UTC. */
function formatDate(date: Date): string {
	if (Number.isNaN(date.getTime())) {
		throw new NeonError('Cannot encode: an invalid Date');
	}
	try {
		return NeonDate.fromDate(date).toString();
	} catch {
		throw new NeonError('Cannot encode: a Date out of the years 0 to 9999');
	}
}


/** Prefixes every non-empty line. */
function indent(text: string, indentation: string): string {
	return text.split('\n').map((line) => line === '' ? line : indentation + line).join('\n'); // a regex would also split at CR and U+2028
}


function isPlainObject(value: unknown): value is object {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}


function isMapLike(value: unknown): boolean {
	return value instanceof Map || isPlainObject(value);
}
