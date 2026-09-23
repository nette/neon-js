import { NeonError } from './errors.ts';
import { setSlots } from './internal.ts';
import { quote, tokenize } from './lexer.ts';
import {
	ArrayItemNode,
	BlockArrayNode,
	DocumentNode,
	EntityChainNode,
	EntityNode,
	InlineArrayNode,
	LiteralNode,
	StringNode,
	type ValueNode,
} from './nodes.ts';
import { Cursor } from './position.ts';
import type { Token, TokenKind } from './token.ts';
import { Chain, EscapeError, evaluateString, Int64Max, isIntegerKey, literalKey, MaxDepth } from './values.ts';


/** Parses NEON into the lossless syntax tree. */
export function parse(input: string): DocumentNode {
	return new Parser(tokenize(input), input).parse();
}


type Expected = TokenKind | 'Newline';

const TooDeep = 'Too deep nesting';

const Pairs: Partial<Record<TokenKind, TokenKind>> = {
	OpenBracket: 'CloseBracket',
	OpenBrace: 'CloseBrace',
	OpenParen: 'CloseParen',
};

interface Mark {
	i: number;
	newlineTaken: boolean;
}

/** The indentation of a block opened on the line of a dash, decided by the line where it is first needed. */
interface PendingIndent {
	base: Indent;
	resolved: string | null;
	line: Mark | null;
}

type Indent = string | PendingIndent;


/**
 * The parser of nette/neon 3.x ported onto tokens with trivia. Line endings are trivia, but the
 * parser sees them as it saw the Newline tokens of 3.x: before token i stands a line break if the
 * trivia between token i-1 and token i contain a line ending.
 */
class Parser {
	#i = 0;
	#newlineTaken = false;
	#depth = 0;
	readonly #cursor: Cursor;


	constructor(
		private readonly tokens: Token[],
		input: string,
	) {
		this.#cursor = new Cursor(input);
	}


	parse(): DocumentNode {
		while (this.consume('Newline')) { ; }
		const value = this.parseBlock(this.getIndentation());

		while (this.consume('Newline')) { ; }
		if (this.isNext()) {
			this.error();
		}

		const document = new DocumentNode(value, this.tokens.at(-1)!);
		this.verify(document);
		return document;
	}


	private parseBlock(indent: Indent, onlyBullets = false): ValueNode | null {
		const depth = this.#depth;
		try {
			return this.parseBlockItems(indent, onlyBullets);
		} finally {
			this.#depth = depth;
		}
	}


	/**
	 * A block opened on the line of a dash is indented by a tab if the line where its indentation is first
	 * compared starts with one, by two spaces otherwise. 3.x tries the tab and then the spaces, which costs time
	 * exponential in nested dashes; the spaces fail on that line whenever the tab was chosen, so a block
	 * that fails with the tab fails as the spaces would.
	 */
	private parseDashBlock(base: Indent): ValueNode | null {
		const indent: PendingIndent = { base, resolved: null, line: null };
		try {
			return this.parseBlock(indent);
		} catch (e) {
			if (e instanceof NeonError && e.message !== TooDeep && indent.resolved?.endsWith('\t') && indent.line) {
				this.#i = indent.line.i;
				this.#newlineTaken = indent.line.newlineTaken;
				this.error('Invalid combination of tabs and spaces');
			}
			throw e;
		}
	}


	/** The indentation of a block, decided for a block opened on the line of a dash by the indentation of the next line. */
	private resolve(indent: Indent, next: string): string {
		if (typeof indent === 'string') {
			return indent;
		} else if (indent.resolved === null) {
			const base = this.resolve(indent.base, next);
			indent.resolved = base + (next.startsWith(base + '\t') ? '\t' : '  ');
			indent.line = this.mark();
		}
		return indent.resolved;
	}


	private parseBlockItems(pending: Indent, onlyBullets: boolean): ValueNode | null {
		const items: ArrayItemNode[] = [];
		const keys = new KeyCheck(this);

		while (true) {
			const bullet = this.consumeToken('Dash');
			let key: StringNode | LiteralNode | null = null;
			let colon: Token | null = null;
			let value: ValueNode | null = null;

			if (bullet) {
				if (!items.length) {
					this.enter(bullet);
				}
			} else if (!this.isNext() || onlyBullets) {
				return items.length ? new BlockArrayNode(items) : null;
			} else {
				const head = this.parseValue();
				if ((colon = this.consumeToken('Colon', 'Equals'))) {
					key = keys.add(head);
					if (!items.length) {
						this.enter(head.getFirstToken());
					}
				} else {
					if (items.length) {
						this.error();
					}
					return head;
				}
			}

			if (this.consume('Newline')) {
				while (this.consume('Newline')) { ; }
				const nextIndent = this.getIndentation();
				const indent = this.resolve(pending, nextIndent);
				if (!comparable(nextIndent, indent)) {
					this.error('Invalid combination of tabs and spaces');
				} else if (nextIndent.length > indent.length) { // open new block
					value = this.parseBlock(nextIndent);
				} else if (nextIndent.length < indent.length) { // close block
					items.push(keys.item(bullet, key, colon, null));
					return new BlockArrayNode(items);
				} else if (key !== null && this.isNext('Dash')) { // special dash subblock
					value = this.parseBlock(indent, true);
				}

			} else if (key === null) { // open new block after dash
				value = this.parseDashBlock(pending);

			} else if (this.isNext()) {
				value = this.parseValue();
				if (this.isNext() && !this.isNext('Newline')) {
					this.error();
				}
			}

			items.push(keys.item(bullet, key, colon, value));

			while (this.consume('Newline')) { ; }
			if (!this.isNext()) {
				return new BlockArrayNode(items);
			}

			const nextIndent = this.getIndentation();
			const indent = this.resolve(pending, nextIndent);
			if (!comparable(nextIndent, indent)) {
				this.error('Invalid combination of tabs and spaces');
			} else if (nextIndent.length > indent.length) {
				this.error('Bad indentation');
			} else if (nextIndent.length < indent.length) { // close block
				return new BlockArrayNode(items);
			}
		}
	}


	private parseValue(): ValueNode {
		let node: ValueNode;
		let token: Token | null;
		if ((token = this.consumeToken('String'))) {
			try {
				evaluateString(token.text);
			} catch (e) {
				if (e instanceof EscapeError) {
					this.error(e.message, token);
				}
				throw e;
			}
			node = new StringNode(token);

		} else if ((token = this.consumeToken('Literal'))) {
			node = new LiteralNode(token);

		} else if (this.isNext('OpenBracket', 'OpenParen', 'OpenBrace')) {
			node = this.parseBraces();

		} else {
			this.error();
		}

		return this.parseEntity(node);
	}


	private parseEntity(node: ValueNode): ValueNode {
		if (!this.isNext('OpenParen')) {
			return node;
		}

		this.checkEntityHead(node);
		const entities = [new EntityNode(node, this.parseBraces())];
		let token: Token | null;
		while ((token = this.consumeToken('Literal'))) {
			const head = new LiteralNode(token);
			this.checkEntityHead(head);
			if (this.isNext('OpenParen')) {
				entities.push(new EntityNode(head, this.parseBraces()));
			} else {
				entities.push(new EntityNode(head, null));
				break;
			}
		}

		return entities.length === 1
			? entities[0]!
			: new EntityChainNode(entities);
	}


	private parseBraces(): InlineArrayNode {
		const depth = this.#depth;
		try {
			return this.parseBracesItems();
		} finally {
			this.#depth = depth;
		}
	}


	private parseBracesItems(): InlineArrayNode {
		const open = this.consumeToken()!;
		this.enter(open);
		const end = Pairs[open.kind]!;
		const items: ArrayItemNode[] = [];
		const keys = new KeyCheck(this);

		while (true) {
			while (this.consume('Newline')) { ; }
			const close = this.consumeToken(end);
			if (close) {
				return new InlineArrayNode(open, items, close);
			}

			const head = this.parseValue();
			let item: ArrayItemNode;
			const colon = this.consumeToken('Colon', 'Equals');
			if (colon) {
				const key = keys.add(head);
				const value = this.isNext('Newline', 'Comma', end) ? null : this.parseValue();
				item = keys.item(null, key, colon, value);
			} else {
				item = keys.item(null, null, null, head);
			}
			items.push(item);

			const before = this.mark();
			while (this.consume('Newline')) { ; }
			const comma = this.consumeToken('Comma');
			if (comma) {
				item[setSlots]({ separator: comma });
			}
			if (before.i !== this.#i || before.newlineTaken !== this.#newlineTaken) {
				continue;
			} else if (!this.isNext(end)) {
				this.error();
			}
		}
	}


	/** One level deeper into arrays. */
	private enter(token: Token): void {
		if (++this.#depth > MaxDepth) {
			this.error(TooDeep, token);
		}
	}


	private checkEntityHead(node: ValueNode): void {
		const value = node instanceof StringNode
			? node.toValue()
			: node instanceof LiteralNode
				? node.token.text
				: null;
		if (value === Chain) {
			this.error(`Entity name '${Chain}' is reserved`, node.getFirstToken());
		}
	}


	/** Every token of the stream is in the tree exactly once, in the order of the stream. */
	private verify(document: DocumentNode): void {
		const tokens = document.getTokens();
		if (tokens.length !== this.tokens.length || tokens.some((token, i) => token !== this.tokens[i])) {
			throw new Error('Internal error: the tree does not hold the tokens of the input in order.');
		}
	}


	// stream of tokens with line breaks


	private newlineBefore(i: number): boolean {
		const trivia = i === 0 ? this.tokens[0]!.leadingTrivia : this.tokens[i - 1]!.trailingTrivia;
		return trivia.some((t) => t.kind === 'LineEnding');
	}


	private peek(): Expected {
		return !this.#newlineTaken && this.newlineBefore(this.#i)
			? 'Newline'
			: this.tokens[this.#i]!.kind;
	}


	/** Whether the next item is of one of the kinds; without kinds, whether anything but the end follows. */
	isNext(...kinds: Expected[]): boolean {
		const next = this.peek();
		return kinds.length ? kinds.includes(next) : next !== 'EndOfFile';
	}


	private consume(kind: 'Newline'): boolean {
		if (this.peek() === kind) {
			this.#newlineTaken = true;
			return true;
		}
		return false;
	}


	private consumeToken(...kinds: TokenKind[]): Token | null {
		const next = this.peek();
		if (next === 'Newline' || next === 'EndOfFile' || (kinds.length && !kinds.includes(next))) {
			return null;
		}
		this.#newlineTaken = false;
		return this.tokens[this.#i++]!;
	}


	private mark(): Mark {
		return { i: this.#i, newlineTaken: this.#newlineTaken };
	}


	/** Indentation of the next token if it starts a line: the whitespace right after a line ending or the start. */
	private getIndentation(): string {
		const i = this.#i;
		const trivia = i === 0
			? this.tokens[0]!.leadingTrivia.filter((t) => t.kind !== 'ByteOrderMark')
			: [...this.tokens[i - 1]!.trailingTrivia, ...this.tokens[i]!.leadingTrivia];
		const last = trivia.at(-1);
		const before = trivia.at(-2);
		return last?.kind === 'Whitespace' && (trivia.length === 1 ? i === 0 : before?.kind === 'LineEnding')
			? last.text
			: '';
	}


	error(message?: string, token?: Token): never {
		if (token) {
			throw new NeonError(message!, token.origin);
		}

		const next = this.peek();
		if (next === 'Newline') {
			const [offset, count] = this.locateNewline();
			throw new NeonError(message ?? `Unexpected '${'<new line>'.repeat(Math.min(count, 40))}'`, this.#cursor.at(offset));
		}

		const current = this.tokens[this.#i]!;
		throw new NeonError(
			message ?? (next === 'EndOfFile' ? 'Unexpected end' : `Unexpected '${quote(current.text)}'`),
			current.origin,
		);
	}


	/** Offset of the line break before the current token, and how many line endings follow one another there. */
	private locateNewline(): [number, number] {
		const i = this.#i;
		const prev = this.tokens[i - 1];
		let offset = prev ? prev.origin!.utf16Offset + prev.text.length : 0;
		const trivia = [...prev?.trailingTrivia ?? [], ...this.tokens[i]!.leadingTrivia];
		let k = 0;
		while (trivia[k]!.kind !== 'LineEnding') {
			offset += trivia[k++]!.text.length;
		}
		let count = 0;
		while (trivia[k + count]?.kind === 'LineEnding') {
			count++;
		}
		return [offset, count];
	}
}


/** Checks explicit keys of one array for duplicates and implicit keys for overflow. */
class KeyCheck {
	readonly #seen = (new Set<string>);
	#max: bigint | null = null;


	constructor(
		private readonly parser: Parser,
	) {
	}


	add(node: ValueNode): StringNode | LiteralNode {
		if (!(node instanceof StringNode || node instanceof LiteralNode)) {
			this.parser.error('Unacceptable key', node.getFirstToken());
		}

		const key = node instanceof StringNode ? node.toValue() : literalKey(node.token.text);
		if (this.#seen.has(key)) {
			this.parser.error(`Duplicated key '${key}'`, node.token);
		}
		this.#seen.add(key);
		return node;
	}


	/** Makes the item and accounts its key, explicit or implicit. */
	item(bullet: Token | null, key: StringNode | LiteralNode | null, colon: Token | null, value: ValueNode | null): ArrayItemNode {
		const item = new ArrayItemNode(bullet, key, colon, value);
		let canonical = item.getKeyValue();
		if (canonical === null) {
			const next = this.#max === null ? 0n : this.#max + 1n;
			if (next > Int64Max) {
				this.parser.error('Implicit key overflow', (value ?? item).getFirstToken());
			}
			canonical = String(next);
		}
		if (isIntegerKey(canonical)) {
			const n = BigInt(canonical);
			this.#max = this.#max === null || n > this.#max ? n : this.#max;
		}
		return item;
	}
}


function comparable(a: string, b: string): boolean {
	const n = Math.min(a.length, b.length);
	return a.slice(0, n) === b.slice(0, n);
}
