import type { TokenKind, TriviaKind } from './token.ts';


export type ScannedKind = TokenKind | 'Trivia';

export interface Scanned {
	kind: ScannedKind;
	triviaKind?: TriviaKind;
	start: number;
	end: number;
}


/** Reads tokens and trivia one by one. Returns null on an error, with errorAt set. */
export class Scanner {
	#pos = 0;
	errorAt = -1;


	constructor(
		private readonly s: string,
	) {
	}


	get position(): number {
		return this.#pos;
	}


	next(): Scanned | null {
		const s = this.s;
		const start = this.#pos;
		const c = s[start];
		if (c === undefined) {
			return null;
		}

		let kind: ScannedKind;
		let triviaKind: TriviaKind | undefined;
		let end: number;

		if (start === 0 && s.charCodeAt(0) === 0xFEFF) {
			kind = 'Trivia';
			triviaKind = 'ByteOrderMark';
			end = 1;

		} else if (c === '\'' || c === '"') {
			kind = 'String';
			end = s.startsWith(c + c + c, start) && this.isLineEnding(start + 3)
				? this.scanMultiline(start, c + c + c)
				: -1;
			if (end < 0) { // a triple without a closing line is read as single-line quotes
				end = c === '\'' ? this.scanSingleQuoted(start) : this.scanDoubleQuoted(start);
			}

		} else if (c === '#') {
			kind = 'Trivia';
			triviaKind = 'Comment';
			end = start + 1;
			while (end < s.length && !this.isLineEnding(end)) {
				end++;
			}

		} else if (this.isLineEnding(start)) {
			kind = 'Trivia';
			triviaKind = 'LineEnding';
			end = start + (c === '\r' ? 2 : 1);

		} else if (this.isSpace(start)) {
			kind = 'Trivia';
			triviaKind = 'Whitespace';
			end = start + 1;
			while (this.isSpace(end)) {
				end++;
			}

		} else if (c in Punctuation) {
			kind = Punctuation[c]!;
			end = start + 1;

		} else if (c === ':' || c === '-') {
			const next = s[start + 1];
			const prev = s[start - 1];
			if (next !== undefined && !this.isAny(start + 1, '"\',=[]{}()') && prev !== '"' && prev !== '\'') {
				kind = 'Literal';
				end = this.scanLiteral(start + 2); // the next character belongs to the start of the literal
			} else {
				kind = c === ':' ? 'Colon' : 'Dash';
				end = start + 1;
			}

		} else if (!this.isAny(start, '#"\',:=[]{}()`')) {
			kind = 'Literal';
			end = this.scanLiteral(start + 1);

		} else {
			end = -1;
			kind = 'Trivia';
		}

		if (end < 0) {
			this.errorAt = start;
			return null;
		}

		this.#pos = end;
		return { kind, triviaKind, start, end };
	}


	/** Is the character one of the given ones, a space, a tab, or a line ending? */
	private isAny(i: number, chars: string): boolean {
		const c = this.s[i];
		return c === undefined || c === ' ' || c === '\t' || c === '\n' || c === '\r' || chars.includes(c);
	}


	private isSpace(i: number): boolean {
		const c = this.s[i];
		return c === ' ' || c === '\t' || (c === '\r' && this.s[i + 1] !== '\n');
	}


	private isLineEnding(i: number): boolean {
		const c = this.s[i];
		return c === '\n' || (c === '\r' && this.s[i + 1] === '\n');
	}


	private scanLiteral(i: number): number {
		const s = this.s;
		while (true) {
			if (i < s.length && !this.isAny(i, ',:=]})(')) {
				i++;
				while (i < s.length && !this.isAny(i, ',:=]})(')) {
					i++;
				}
			} else if (s[i] === ':' && i + 1 < s.length && !this.isAny(i + 1, ',]})')) {
				i++;
			} else if (this.isSpace(i)) {
				let j = i + 1;
				while (this.isSpace(j)) {
					j++;
				}
				if (j < s.length && !this.isAny(j, '#,:=]})(')) {
					i = j;
				} else {
					return i;
				}
			} else {
				return i;
			}
		}
	}


	private scanSingleQuoted(start: number): number {
		const s = this.s;
		let i = start + 1;
		while (i < s.length) {
			if (s[i] === '\'' && s[i + 1] === '\'') {
				i += 2;
			} else if (s[i] === '\'' || s[i] === '\n') {
				break;
			} else {
				i++;
			}
		}
		return s[i] === '\'' ? i + 1 : -1;
	}


	private scanDoubleQuoted(start: number): number {
		const s = this.s;
		let i = start + 1;
		while (i < s.length) {
			if (s[i] === '\\' && i + 1 < s.length && !this.isLineEnding(i + 1)) {
				i += 2;
			} else if (s[i] === '"' || s[i] === '\\' || s[i] === '\n') {
				break;
			} else {
				i++;
			}
		}
		return s[i] === '"' ? i + 1 : -1;
	}


	/**
	 * Content runs to the first line after the first one that starts with optional spaces and the
	 * closing triple; only without such a line may the first line itself close an empty string.
	 */
	private scanMultiline(start: number, triple: string): number {
		const s = this.s;
		const first = s.indexOf('\n', start) + 1;
		for (let i = s.indexOf('\n', first); i >= 0; i = s.indexOf('\n', i + 1)) {
			const end = this.closingAt(i + 1, triple);
			if (end >= 0) {
				return end;
			}
		}
		return this.closingAt(first, triple);
	}


	private closingAt(i: number, triple: string): number {
		while (this.isSpace(i)) {
			i++;
		}
		return this.s.startsWith(triple, i) ? i + 3 : -1;
	}
}


const Punctuation: Record<string, TokenKind> = {
	',': 'Comma',
	'=': 'Equals',
	'[': 'OpenBracket',
	']': 'CloseBracket',
	'{': 'OpenBrace',
	'}': 'CloseBrace',
	'(': 'OpenParen',
	')': 'CloseParen',
};
