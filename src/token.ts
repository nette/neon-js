import { forgetOrigin, record, setLeading, setTrailing } from './internal.ts';
import { Scanner } from './scanner.ts';


export type TokenKind
	= | 'String'
		| 'Literal'
		| 'Colon'
		| 'Equals'
		| 'Comma'
		| 'Dash'
		| 'OpenBracket'
		| 'CloseBracket'
		| 'OpenBrace'
		| 'CloseBrace'
		| 'OpenParen'
		| 'CloseParen'
		| 'EndOfFile';

export type TriviaKind = 'Whitespace' | 'LineEnding' | 'Comment' | 'ByteOrderMark';


/** Line and column are 1-based, offset 0-based; all in code points. utf16Offset indexes the JavaScript string. */
export interface Position {
	readonly line: number;
	readonly column: number;
	readonly offset: number;
	readonly utf16Offset: number;
}


/** Whitespace, a line ending, a comment or a byte order mark around a token. */
export class Trivia {
	constructor(
		readonly kind: TriviaKind,
		readonly text: string,
	) {
		if (classifyTrivia(text) !== kind) {
			throw new TypeError(`${JSON.stringify(text)} is not ${kind}.`);
		}
		Object.freeze(this);
	}


	static fromText(text: string): Trivia {
		const kind = classifyTrivia(text);
		if (!kind) {
			throw new TypeError(`${JSON.stringify(text)} is not one trivia.`);
		}
		return new Trivia(kind, text);
	}


	withText(text: string): Trivia {
		const trivia = Trivia.fromText(text);
		if (trivia.kind !== this.kind) {
			throw new TypeError(`${JSON.stringify(text)} is not ${this.kind}.`);
		}
		return trivia;
	}


	is(...kinds: TriviaKind[]): boolean {
		return kinds.includes(this.kind);
	}


	/** Text of a comment without # and trimmed, or empty string for other trivia. */
	getCommentText(): string {
		return this.kind === 'Comment' ? this.text.slice(1).trim() : '';
	}
}


function classifyTrivia(text: string): TriviaKind | null {
	if (/^(?:[ \t]|\r(?!\n))+$/.test(text)) {
		return 'Whitespace';
	} else if (text === '\n' || text === '\r\n') {
		return 'LineEnding';
	} else if (/^#[^\n]*$/.test(text) && text.isWellFormed()) {
		return 'Comment';
	} else if (text === String.fromCharCode(0xFEFF)) {
		return 'ByteOrderMark';
	}
	return null;
}


/** A token of the source with the trivia around it. */
export class Token {
	#kind: TokenKind;
	#origin: Position | null;
	#text: string;
	#leadingTrivia: readonly Trivia[];
	#trailingTrivia: readonly Trivia[];


	/** Prefer Token.fromText(); the text must be one token of the kind and the trivia canonical. */
	constructor(
		kind: TokenKind,
		text: string,
		leadingTrivia: readonly Trivia[] = [],
		trailingTrivia: readonly Trivia[] = [],
		origin: Position | null = null,
	) {
		if (!trusted) {
			checkText(kind, text);
			checkTrivia(leadingTrivia, 'leading', kind === 'EndOfFile');
			checkTrivia(trailingTrivia, 'trailing', false);
			if (kind === 'EndOfFile' && trailingTrivia.length) {
				throw new TypeError('EndOfFile has no trailing trivia.');
			}
		}
		this.#kind = kind;
		this.#text = text;
		this.#leadingTrivia = Object.freeze([...leadingTrivia]);
		this.#trailingTrivia = Object.freeze([...trailingTrivia]);
		this.#origin = origin;
	}


	/** Makes a token of the kind the scanner reads the text as. */
	static fromText(text: string): Token {
		const kind = text.isWellFormed() ? scanSingleToken(text) : null;
		if (!kind) {
			throw new TypeError(`${JSON.stringify(text)} is not one token.`);
		}
		return new Token(kind, text);
	}


	/** A token changes its kind only by being replaced. */
	get kind(): TokenKind {
		return this.#kind;
	}


	/** Where the token stood in the source it was read from; null for a token made otherwise. A clone keeps it. */
	get origin(): Position | null {
		return this.#origin;
	}


	get text(): string {
		return this.#text;
	}


	get leadingTrivia(): readonly Trivia[] {
		return this.#leadingTrivia;
	}


	get trailingTrivia(): readonly Trivia[] {
		return this.#trailingTrivia;
	}


	/** Replaces the text by another one of the same kind. */
	setText(text: string): this {
		checkText(this.#kind, text);
		const old = this.#text;
		record(() => this.#text = old);
		this.#text = text;
		return this;
	}


	setLeadingTrivia(trivia: readonly Trivia[]): this {
		return this[setLeading](trivia);
	}


	setTrailingTrivia(trivia: readonly Trivia[]): this {
		return this[setTrailing](trivia);
	}


	/** Replaces a trivia, found by identity, in the leading or trailing trivia. */
	replaceTrivia(old: Trivia, replacement: Trivia): this {
		const replace = (list: readonly Trivia[]) => list.map((trivia) => trivia === old ? replacement : trivia);
		if (this.#leadingTrivia.includes(old)) {
			this.setLeadingTrivia(replace(this.#leadingTrivia));
		} else if (this.#trailingTrivia.includes(old)) {
			this.setTrailingTrivia(replace(this.#trailingTrivia));
		} else {
			throw new TypeError('The trivia does not belong to the token.');
		}
		return this;
	}


	is(...kinds: TokenKind[]): boolean {
		return kinds.includes(this.#kind);
	}


	/** A detached copy with the same text, trivia and origin. */
	clone(): Token {
		return trustedToken(this.#kind, this.#text, this.#leadingTrivia, this.#trailingTrivia, this.#origin);
	}


	/** The source text of the token with its trivia. */
	toString(): string {
		let res = '';
		for (const trivia of this.#leadingTrivia) {
			res += trivia.text;
		}
		res += this.#text;
		for (const trivia of this.#trailingTrivia) {
			res += trivia.text;
		}
		return res;
	}


	/** @internal Sets the leading trivia without the checks of the place, for an edit that moves trivia in steps. */
	[setLeading](trivia: readonly Trivia[]): this {
		checkTrivia(trivia, 'leading', this.#kind === 'EndOfFile');
		const old = this.#leadingTrivia;
		record(() => this.#leadingTrivia = old);
		this.#leadingTrivia = Object.freeze(uniqueTrivia(trivia));
		return this;
	}


	/** @internal */
	[setTrailing](trivia: readonly Trivia[]): this {
		checkTrivia(trivia, 'trailing', this.#kind === 'EndOfFile');
		const old = this.#trailingTrivia;
		record(() => this.#trailingTrivia = old);
		this.#trailingTrivia = Object.freeze(uniqueTrivia(trivia));
		return this;
	}


	/** @internal For a token made from a text that is not the source of the document. */
	[forgetOrigin](): void {
		this.#origin = null;
	}
}


let trusted = false;


/** @internal A token whose text and trivia are known to be valid: one the lexer reads or a clone. */
export function trustedToken(kind: TokenKind, text: string, leading: readonly Trivia[], trailing: readonly Trivia[], origin: Position | null): Token {
	trusted = true;
	try {
		return new Token(kind, text, leading, trailing, origin);
	} finally {
		trusted = false;
	}
}


function checkText(kind: TokenKind, text: string): void {
	if (!text.isWellFormed() || (kind === 'EndOfFile' ? text !== '' : scanSingleToken(text) !== kind)) {
		throw new TypeError(`${JSON.stringify(text)} is not one token of kind ${kind}.`);
	}
}


function checkTrivia(list: readonly Trivia[], side: 'leading' | 'trailing', endOfFile: boolean): void {
	if (side === 'trailing' && endOfFile && list.length) {
		throw new TypeError('EndOfFile has no trailing trivia.');
	}
	list.forEach((trivia, i) => {
		const next = list[i + 1];
		if (!(trivia instanceof Trivia)) {
			throw new TypeError('Trivia expected.');
		} else if (trivia.kind === 'Whitespace' && next?.kind === 'Whitespace') {
			throw new TypeError('Two whitespace trivia must not stand next to each other.');
		} else if (trivia.kind === 'ByteOrderMark' && (side !== 'leading' || i > 0)) {
			throw new TypeError('A byte order mark may only be the first leading trivia.');
		} else if (trivia.kind === 'LineEnding' && side === 'trailing' && next) {
			throw new TypeError('A line ending must be the last of the trailing trivia.');
		} else if (trivia.kind === 'Comment' && next?.kind !== 'LineEnding' && (next || (side === 'leading' && !endOfFile))) {
			throw new TypeError('A comment must be followed by a line ending.');
		} else if (trivia.text.endsWith('\r') && next?.text.startsWith('\n')) {
			throw new TypeError('A carriage return before a line feed would make one line ending of the two.');
		}
	});
}


/** A copy of the list where an instance stands once, so that replaceTrivia() finds the one meant. */
function uniqueTrivia(list: readonly Trivia[]): Trivia[] {
	const seen = (new Set<Trivia>);
	return list.map((trivia) => seen.has(trivia) ? new Trivia(trivia.kind, trivia.text) : (seen.add(trivia), trivia));
}


/** Kind of the text if the scanner reads it as exactly one token without trivia. */
function scanSingleToken(text: string): TokenKind | null {
	const scanner = new Scanner(text);
	const token = scanner.next();
	return token && token.end === text.length && token.kind !== 'Trivia'
		? token.kind
		: null;
}
