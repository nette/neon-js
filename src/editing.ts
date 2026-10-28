// The editing operations of the tree. The node classes expose them as methods.

import { Builder, type Place } from './builder.ts';
import { encode } from './encoder.ts';
import { NeonError } from './errors.ts';
import { setItems, setLeading, setSlots, setTrailing } from './internal.ts';
import { Layout } from './layout.ts';
import {
	ArrayItemNode,
	ArrayNode,
	BlockArrayNode,
	DocumentNode,
	EntityChainNode,
	EntityNode,
	InlineArrayNode,
	itemKeys,
	LiteralNode,
	type Node,
	type NodeClass,
	StringNode,
	ValueNode,
} from './nodes.ts';
import { findNeighbour, Token, type TokenKind, Trivia } from './token.ts';
import { Chain, Entity, entriesOf, literalKey, MaxDepth, NeonDate, valuesEqual } from './values.ts';


/** What happens to the comments a removed item owns: the one on its line and those directly above it; the comments inside its value go with it. */
export const CommentPolicy = {
	/** The comments that describe the item go with it. */
	Drop: 'drop',
	/** The comments stay, above whatever follows. */
	MoveToNextToken: 'move',
} as const;

export type CommentPolicy = typeof CommentPolicy[keyof typeof CommentPolicy];

export type PathSegment = string | number | { item: number };


// ---- values of items


/** Writes the value of an item; an equal value is a no-op, a changed one keeps the style where it can. */
export function setItemValue(item: ArrayItemNode, value: unknown): void {
	const old = item.value;
	if (value instanceof ValueNode) {
		setItemNode(item, value);
		return;
	} else if (old ? sameValue(value, old) : value === null) {
		return;
	} else if (value === null && !item.colon && !item.bullet) {
		replaceValue(item, literal('null')); // an inline item without a key cannot lose its value
	} else if (value === null) {
		replaceValue(item, null);
	} else {
		replaceValue(item, styledScalar(old, value) ?? Builder.value(value, placeOf(item, old, value)));
	}
	guardGrammar(item.parent);
}


/** Puts the node into the value slot or empties it, without the comparison and styling of setItemValue(). */
export function setItemNode(item: ArrayItemNode, node: ValueNode | null): void {
	replaceValue(item, node);
	guardGrammar(item.parent);
}


/** Repairs what the grammar would read differently in the array after an edit. */
function guardGrammar(array: Node | null): void {
	if (array instanceof BlockArrayNode) {
		guardEnd(array);
		guardDashSubblocks(array);
	} else if (array instanceof InlineArrayNode) {
		guardKeysWithoutValue(array);
	}
}


/**
 * A dash right after a key at the same indentation reads as a dash subblock of that key.
 * So a key without a value followed by a dash gets an explicit null, and a dash right after a dash
 * subblock gets its key written out, which ends the subblock.
 */
function guardDashSubblocks(block: BlockArrayNode): void {
	block.items.forEach((item, i) => {
		const next = block.items[i + 1];
		if (!item.key || !next?.bullet) {
			return;
		} else if (item.value === null) {
			replaceValue(item, literal('null'));
		} else if (item.value instanceof BlockArrayNode && Layout.indentation(item.value.items[0]!) === Layout.indentation(item)) {
			giveKey(next, itemKeys(block.items)[i + 1]!);
		}
	});
}


/** Keeps an item without a key from reading as the value of a key without a value on the line above. */
function guardKeysWithoutValue(array: InlineArrayNode): void {
	array.items.forEach((item, i) => {
		const next = array.items[i + 1];
		if (item.key && item.value === null && !item.separator && next && !next.key) {
			replaceValue(item, literal('null'));
		}
	});
}


/** Spaces on the last line of the input would be read as the indentation of a missing value at the end. */
function guardEnd(at: Node): void {
	let root: Node = at;
	while (root.parent) {
		root = root.parent;
	}
	if (!(root instanceof DocumentNode)) {
		return;
	}
	const end = root.endOfFile;
	const last = tokenBefore(end);
	const item = last?.parent;
	if (item instanceof ArrayItemNode && item.value === null && end.leadingTrivia.at(-1)?.kind === 'Whitespace') {
		lead(end, withoutIndentation(end.leadingTrivia));
	}
}


/** Where a value of the item is built; a replaced block keeps the indentation it had. */
function placeOf(item: ArrayItemNode, old: ValueNode | null, value: unknown): Place {
	const indent = Layout.indentation(item);
	const blockIndent = old instanceof BlockArrayNode ? Layout.indentation(old.items[0]!) : null;
	const unit = blockIndent?.startsWith(indent) && blockIndent.length > indent.length
		? blockIndent.slice(indent.length)
		: Layout.unit(item);
	return { block: item.parent instanceof BlockArrayNode, indent, unit, eol: Layout.lineEnding(item), doubleQuoted: hasFragileString(item, value) };
}


/** Puts a node into the value slot, moving the trivia so that the lines stay as they were. */
function replaceValue(item: ArrayItemNode, node: ValueNode | null): void {
	const old = item.value;
	const head = item.colon ?? item.bullet;
	if (node === old) {
		return;
	} else if (node instanceof BlockArrayNode && (item.parent instanceof InlineArrayNode || !head)) {
		throw new NeonError('A block cannot stand in an inline array.');
	} else if (node) {
		checkPlaceable(item, node);
	} else if (!head) {
		throw new NeonError('The value of an item without a key cannot be empty.');
	}

	if (!head) { // an item of an inline array without a key: the node takes the place of the old one
		takeEdges(node!, old!);
		item[setSlots]({ value: node });
		return;
	}

	const headEnds = hasLineEnding(head.trailingTrivia);
	const oldOnOwnLine = old !== null && headEnds;
	const finalLineEnding = old ? hasLineEnding(old.getLastToken().trailingTrivia) : headEnds;

	if (node === null) {
		if (!oldOnOwnLine) {
			trail(head, old!.getLastToken().trailingTrivia);
		} else if (!finalLineEnding) {
			trail(head, withoutLineEnding(head.trailingTrivia));
		}
		item[setSlots]({ value: null });
		const end = tokenAfter(head);
		if (end?.kind === 'EndOfFile') { // spaces on a last line would be read as the indentation of the missing value
			lead(end, withoutIndentation(end.leadingTrivia));
		}
		return;
	}

	const eol = Layout.lineEnding(head);
	if (node instanceof BlockArrayNode) {
		const place = placeOf(item, old, null);
		reindentBlock(node, place.indent + place.unit);
		if (old && !oldOnOwnLine) {
			trail(head, old.getLastToken().trailingTrivia);
		}
		if (!hasLineEnding(head.trailingTrivia)) {
			trail(head, [...withoutTrailingSpace(head.trailingTrivia), new Trivia('LineEnding', eol)]);
		}
		if (old instanceof BlockArrayNode && oldOnOwnLine) { // the lines above the old block stay
			const first = node.getFirstToken();
			lead(first, joinTrivia(withoutIndentation(old.getFirstToken().leadingTrivia), first.leadingTrivia));
		}
		trail(node.getLastToken(), finalLineEnding ? [new Trivia('LineEnding', eol)] : []);
		item[setSlots]({ value: node });
		return;
	}

	if (old && !(old instanceof BlockArrayNode)) { // the token takes the place of the old one, on its line
		takeEdges(node, old);
	} else {
		const trailing = old && !oldOnOwnLine // a block opened on the line of a dash ends the line itself
			? old.getLastToken().trailingTrivia
			: head.trailingTrivia; // the line ending, and a comment, of the head move after the value
		lead(node.getFirstToken(), []);
		trail(node.getLastToken(), finalLineEnding ? trailing : withoutLineEnding(trailing));
		trail(head, [new Trivia('Whitespace', ' ')]);
	}
	item[setSlots]({ value: node });
}


/** A node that comes into a slot of the owner must be free, and must not hold the owner. */
function checkPlaceable(owner: Node, node: Node): void {
	checkMovable(owner, node);
	if (node instanceof EntityNode && !node.attributes) {
		throw new TypeError('An entity without parentheses can only be a link of a chain.');
	}
	checkDepth(owner, node);
}


function checkMovable(owner: Node, node: Node): void {
	if (node.parent) {
		throw new Error('The node already has a parent, detach() or clone() it first.');
	}
	for (let ancestor: Node | null = owner; ancestor; ancestor = ancestor.parent) {
		if (ancestor === node) {
			throw new Error('A node cannot be put into its own subtree.');
		}
	}
}


/** The arrays around the owner and in the node must not nest deeper than the parser reads. */
function checkDepth(owner: Node, node: Node | null): void {
	let around = 0;
	for (let ancestor: Node | null = owner; ancestor; ancestor = ancestor.parent) {
		around += ancestor instanceof ArrayNode ? 1 : 0;
	}
	const depth = (n: Node): number => (n instanceof ArrayNode ? 1 : 0)
		+ Math.max(0, ...n.getChildren().map((child) => child instanceof ArrayItemNode || child instanceof ValueNode ? depth(child) : 0));
	if (node && around + depth(node) > MaxDepth) {
		throw new NeonError('Too deep nesting');
	}
}


/** Shifts the indentation of all lines of a block, so that its items stand at the given one. */
function reindentBlock(block: BlockArrayNode, to: string): void {
	const items = block.items;
	const from = (items[1] ?? items[0]!).getIndentation(); // the first item may stand on the line of a dash
	reindent(block, from, to);
	const first = block.getFirstToken();
	lead(first, [...withoutIndentation(first.leadingTrivia), ...indentTrivia(to)]);
}


/** The new node takes the leading trivia of the first token and the trailing trivia of the last one. */
function takeEdges(node: Node, old: Node): void {
	lead(node.getFirstToken(), old.getFirstToken().leadingTrivia);
	trail(node.getLastToken(), old.getLastToken().trailingTrivia);
}


/** Equality of values between a value of the host and the value of a node; an array compares in the order of the document. */
function sameValue(value: unknown, node: ValueNode): boolean {
	if (!(node instanceof ArrayNode)) {
		return valuesEqual(value, node.toValue());
	}
	const host = entriesOf(value);
	if (!host) {
		return false;
	}
	const keys = itemKeys(node.items);
	const entries = (new Map<string, ArrayItemNode>);
	node.items.forEach((item, i) => entries.set(keys[i]!, item)); // an overwritten key keeps its first position
	const list = entries.size ? [...entries.keys()].every((key, i) => key === String(i)) : Array.isArray(node.toValue());
	if (host.list !== list || host.entries.length !== entries.size) {
		return false;
	}
	const ordered = [...entries];
	return host.entries.every(([key, v], i) => {
		const item = host.ordered ? (ordered[i]![0] === key ? ordered[i]![1] : undefined) : entries.get(key);
		return item !== undefined && (item.value ? sameValue(v, item.value) : v === null);
	});
}


/** A scalar written in the style of the old one: base of an integer, word of a boolean, quotes of a string. */
function styledScalar(old: ValueNode | null, value: unknown): ValueNode | null {
	if (old instanceof LiteralNode) {
		const text = old.token.text;
		const base = /^0([xob])([0-9a-fA-F]+)$/.exec(text);
		if (base && (typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value))) && value >= 0) {
			const radix = { x: 16, o: 8, b: 2 }[base[1] as 'x' | 'o' | 'b'];
			let digits = value.toString(radix).padStart(base[2]!.length, '0');
			digits = /[A-F]/.test(base[2]!) ? digits.toUpperCase() : digits;
			return literal(`0${base[1]}${digits}`);
		} else if (typeof value === 'boolean') {
			const word = BooleanWords.find(([yes, no]) => text.toLowerCase() === yes || text.toLowerCase() === no);
			if (word) {
				const res = word[value ? 0 : 1];
				return literal(text === text.toUpperCase() ? res.toUpperCase() : /^[A-Z]/.test(text) ? res[0]!.toUpperCase() + res.slice(1) : res);
			}
		} else if (typeof value === 'string' && /^[^\n]*$/.test(value) && literalIsPlainString(old)) {
			const res = encode(value);
			return res === value ? literal(res) : null;
		}
	} else if (old instanceof StringNode && typeof value === 'string') {
		const quote = old.token.text[0];
		const multiline = /^('''|""")\r?\n/.test(old.token.text);
		if (!multiline && !value.includes('\n') && value.isWellFormed()) {
			if (quote === '\'' && !/[\x00-\x08\x0B-\x1F]/.test(value)) { // eslint-disable-line no-control-regex
				return string('\'' + value.replaceAll('\'', '\'\'') + '\'');
			} else if (quote === '"') {
				return string(JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029'));
			}
		}
	}
	return null;
}


const BooleanWords: [string, string][] = [['true', 'false'], ['yes', 'no']];


function literalIsPlainString(node: LiteralNode): boolean {
	return typeof node.toValue() === 'string';
}


function literal(text: string): LiteralNode {
	return new LiteralNode(Token.fromText(text));
}


function string(text: string): StringNode {
	return new StringNode(Token.fromText(text));
}


// ---- adding


/** Adds an item to an array, at the end or before the item at the position. */
export function addItem(array: ArrayNode, key: string | null, value: unknown, position?: number): ArrayItemNode {
	const items = array.items;
	const at = position ?? items.length;
	if (at < 0 || at > items.length || !Number.isInteger(at)) {
		throw new RangeError(`Position ${at} is out of the array.`);
	} else if (key !== null && array.findItem(key)) {
		throw new NeonError(`Duplicated key '${key}'`);
	} else if (value instanceof ValueNode) {
		if (value instanceof BlockArrayNode && array instanceof InlineArrayNode) {
			throw new NeonError('A block cannot stand in an inline array.');
		}
		checkPlaceable(array, value);
	}

	const before = keysBefore(array);
	const item = array instanceof BlockArrayNode
		? addToBlock(array, key, value, at)
		: addToInline(array as InlineArrayNode, key, value, at);
	keepKeys(array, before, key === null);
	guardGrammar(array);
	return item;
}


/** The keys of the items before an edit, and whether they made a list. */
function keysBefore(array: ArrayNode): { keys: Map<ArrayItemNode, string>; list: boolean } {
	const keys = itemKeys(array.items);
	return {
		keys: new Map(array.items.map((item, i) => [item, keys[i]!])),
		list: listLength(array, keys) !== null,
	};
}


/**
 * The length of the list the items make in the decoded array, where an overwritten key keeps the place of its first
 * item; null when they make no list.
 */
function listLength(array: ArrayNode, keys: readonly string[]): number | null {
	if (!keys.length) {
		return Array.isArray(array.toValue()) ? 0 : null; // `{}` is no list
	}
	const seen = (new Set<string>);
	for (const key of keys) {
		if (!seen.has(key)) {
			if (key !== String(seen.size)) {
				return null;
			}
			seen.add(key);
		}
	}
	return seen.size;
}


/**
 * An edit must not change the keys of the other items. In a list, an item added or removed without a
 * key renumbers the following ones, which is what a list means; anywhere else, an item whose implicit
 * key would change gets its old key written out (`{5: a, b}` without `5: a` is `{6: b}`).
 */
function keepKeys(array: ArrayNode, before: { keys: Map<ArrayItemNode, string>; list: boolean }, keyless: boolean): void {
	if (before.list && keyless) {
		itemKeys(array.items); // an implicit key out of range fails here
		return;
	}
	for (let changed = true; changed;) {
		changed = false;
		const keys = itemKeys(array.items);
		for (const [i, item] of array.items.entries()) {
			const old = before.keys.get(item);
			if (old !== undefined && !item.key && keys[i] !== old && giveKey(item, old)) {
				changed = true;
				break; // the key changes the implicit keys after it
			}
		}
	}
}


/** Writes the key out: `- b` becomes `6: b`, an inline `b` becomes `6: b`. */
function giveKey(item: ArrayItemNode, key: string): boolean {
	const [, keyNode, colon] = headTokens(key);
	if (item.bullet) {
		lead(keyNode!.getFirstToken(), item.bullet.leadingTrivia);
		if (item.value instanceof BlockArrayNode && !hasLineEnding(item.bullet.trailingTrivia)) {
			// a block opened on the line of the dash moves to the lines below the key
			const first = item.value.items[0]!;
			lead(first.getFirstToken(), indentTrivia(Layout.indentation(first)));
			trail(colon!, [new Trivia('LineEnding', Layout.lineEnding(item))]);
		} else {
			trail(colon!, item.bullet.trailingTrivia);
		}
		item[setSlots]({ bullet: null, key: keyNode, colon });
	} else {
		const first = item.getFirstToken();
		lead(keyNode!.getFirstToken(), first.leadingTrivia);
		lead(first, []);
		item[setSlots]({ key: keyNode, colon });
	}
	return true;
}


function addToBlock(block: BlockArrayNode, key: string | null, value: unknown, at: number): ArrayItemNode {
	const items = block.items;
	const sibling = items[Math.min(at, items.length - 1)]!;
	const indent = Layout.indentation(sibling);
	const eol = Layout.lineEnding(sibling);
	if (value instanceof ValueNode) { // the head first, then the node comes in as the value of a placed item
		const item = Builder.blockItem(key, key === null ? 0 : null, { block: true, indent, unit: Layout.unit(block), eol });
		placeInBlock(block, item, at, indent, eol);
		replaceValue(item, value);
		return item;
	}
	const item = Builder.blockItem(key, value, { block: true, indent, unit: Layout.unit(block), eol, doubleQuoted: hasFragileString(block, value) });
	checkDepth(block, item.value);
	placeInBlock(block, item, at, indent, eol);
	return item;
}


/** Puts a finished item into a block; its first token holds its comments and its indentation. */
function placeInBlock(block: BlockArrayNode, item: ArrayItemNode, at: number, indent: string, eol: string): void {
	const items = block.items;
	const sibling = items[Math.min(at, items.length - 1)]!;
	if (at === items.length) {
		const last = sibling.getLastToken();
		if (!hasLineEnding(last.trailingTrivia)) { // a missing final line ending stays missing
			trail(last, [...last.trailingTrivia, new Trivia('LineEnding', eol)]);
			trail(item.getLastToken(), []);
		}
	} else if (!startsLine(sibling)) { // the first item of a block opened on the line of a dash
		lead(item.getFirstToken(), []);
		lead(sibling.getFirstToken(), indentTrivia(indent));
	} else {
		const { preamble, owned } = splitLeading(sibling.getFirstToken().leadingTrivia);
		lead(item.getFirstToken(), [...preamble, ...item.getFirstToken().leadingTrivia]);
		lead(sibling.getFirstToken(), owned);
	}

	block[setItems]([...items.slice(0, at), item, ...items.slice(at)]);
}


/**
 * Inserts an item taken out of a tree, with its comments, reindented to its new place: the common
 * prefix of the indentation of all its lines moves. The lines inside a multiline string are part
 * of its token and its value, so they stay.
 */
export function insertItem(array: ArrayNode, item: ArrayItemNode, at: number): void {
	if (!(item instanceof ArrayItemNode)) {
		throw new TypeError('ArrayItemNode expected.');
	} else if (item.parent) {
		throw new Error('The item already has a parent, remove() it first.');
	} else if (at < 0 || at > array.items.length || !Number.isInteger(at)) {
		throw new RangeError(`Position ${at} is out of the array.`);
	} else if (array instanceof InlineArrayNode && (item.bullet || item.value instanceof BlockArrayNode)) {
		throw new NeonError('A block item cannot stand in an inline array.');
	} else if (array instanceof BlockArrayNode && !item.bullet && !item.key) {
		throw new NeonError('An item without a key or a dash cannot stand in a block.');
	}
	checkPlaceable(array, item);
	const key = item.getKeyValue();
	if (key !== null && array.findItem(key)) {
		throw new NeonError(`Duplicated key '${key}'`);
	}
	const comments = array instanceof InlineArrayNode ? edgeComments(item) : [];
	if (comments.length && !isSpread(array as InlineArrayNode)) {
		throw new NeonError('An item with comments cannot stand in an inline array on one line.');
	}

	const before = keysBefore(array);
	if (array instanceof BlockArrayNode) {
		const sibling = array.items[Math.min(at, array.items.length - 1)]!;
		const indent = Layout.indentation(sibling);
		const eol = Layout.lineEnding(sibling);
		reindent(item, item.getIndentation(), indent);
		if (item.separator) { // a clone of an item of an inline array, with its comma
			const trailing = withoutTrailingSpace(withoutLineEnding(item.separator.trailingTrivia));
			item[setSlots]({ separator: null });
			trail(item.getLastToken(), trailing);
		}
		trail(item.getLastToken(), [...withoutLineEnding(item.getLastToken().trailingTrivia), new Trivia('LineEnding', eol)]);
		placeInBlock(array, item, at, indent, eol);
	} else {
		lead(item.getFirstToken(), []);
		trail(item.getLastToken(), []);
		if (item.colon && item.value && hasLineEnding(item.colon.trailingTrivia)) { // in brackets, a line ending after the colon means null
			trail(item.colon, [new Trivia('Whitespace', ' ')]);
			lead(item.value.getFirstToken(), []);
		}
		item[setSlots]({ separator: null });
		addToInline(array as InlineArrayNode, null, item, at);
		if (comments.length) {
			placeCommentsAbove(item, comments);
		}
	}
	keepKeys(array, before, key === null);
	guardGrammar(array);
}


/**
 * The comments an item owns at its edges, which an inline array cannot keep in place: the comment lines
 * directly above it, the comments between its key and a value on a later line, and the comment on its line.
 */
function edgeComments(item: ArrayItemNode): Trivia[] {
	const comments = withoutIndentation(splitLeading(item.getFirstToken().leadingTrivia).owned);
	if (item.colon && item.value && hasLineEnding(item.colon.trailingTrivia)) {
		comments.push(...item.colon.trailingTrivia, ...item.value.getFirstToken().leadingTrivia);
	}
	comments.push(...item.getLastToken().trailingTrivia);
	return comments.filter((t) => t.kind === 'Comment');
}


/** Writes the comments as lines of their own above the item, which an inline array spread over lines holds. */
function placeCommentsAbove(item: ArrayItemNode, comments: readonly Trivia[]): void {
	const first = item.getFirstToken();
	const eol = Layout.lineEnding(item);
	const before = tokenBefore(first)!; // the opening bracket, or a comma
	if (!hasLineEnding(before.trailingTrivia)) {
		const indentation = item.parent instanceof InlineArrayNode ? itemIndentation(item.parent) : '';
		trail(before, [...withoutTrailingSpace(before.trailingTrivia), new Trivia('LineEnding', eol)]);
		lead(first, indentTrivia(indentation));
	}
	const { preamble, owned } = splitLeading(first.leadingTrivia);
	const indent = indentationOf(owned);
	const lines = comments.flatMap((comment) => [...indentTrivia(indent), comment, new Trivia('LineEnding', eol)]);
	lead(first, [...preamble, ...withoutIndentation(owned), ...lines, ...indentTrivia(indent)]);
}


/** Replaces the indentation prefix of every line of the node, its comment lines included. */
function reindent(node: Node, from: string, to: string): void {
	const tokens = node.getTokens();
	tokens.forEach((token, k) => {
		let atLineStart = k === 0 || hasLineEnding(tokens[k - 1]!.trailingTrivia);
		const trivia: Trivia[] = [];
		for (const t of token.leadingTrivia) {
			if (atLineStart && t.kind === 'Whitespace' && t.text.startsWith(from)) {
				trivia.push(...indentTrivia(to + t.text.slice(from.length)));
			} else {
				if (atLineStart && from === '' && t.kind !== 'LineEnding' && t.kind !== 'ByteOrderMark') {
					trivia.push(...indentTrivia(to)); // a line without indentation gets the new one
				}
				trivia.push(t);
			}
			atLineStart = t.kind === 'LineEnding';
		}
		if (atLineStart && from === '') { // the line of the token itself
			trivia.push(...indentTrivia(to));
		}
		lead(token, joinAll(trivia));
	});
}


function headTokens(key: string | null): [Token | null, StringNode | LiteralNode | null, Token | null] {
	if (key === null) {
		return [withSpace(Token.fromText('-')), null, null];
	}
	const keyText = Builder.keyText(key);
	return [null, keyText[0] === '\'' || keyText[0] === '"' ? string(keyText) : literal(keyText), withSpace(Token.fromText(':'))];
}


function withSpace(token: Token): Token {
	return trail(token, [new Trivia('Whitespace', ' ')]);
}


function addToInline(array: InlineArrayNode, key: string | null, value: unknown, at: number): ArrayItemNode {
	const items = array.items;
	const multiline = isSpread(array);
	const eol = Layout.lineEnding(array);
	const indentation = itemIndentation(array);
	let item: ArrayItemNode;
	if (value instanceof ArrayItemNode) { // a finished item, inserted
		item = value;
	} else {
		const node = value instanceof ValueNode ? value : Builder.value(value, { block: false, indent: indentation, unit: Layout.unit(array), eol, doubleQuoted: hasFragileString(array, value) });
		if (value instanceof ValueNode) {
			lead(node.getFirstToken(), []);
			trail(node.getLastToken(), []);
		}
		const [, keyNode, colon] = key === null ? [null, null, null] : headTokens(key);
		checkDepth(array, node);
		item = new ArrayItemNode(null, keyNode, colon, node);
	}
	const space = () => multiline ? [new Trivia('LineEnding', eol)] : [new Trivia('Whitespace', ' ')];

	if (!items.length) {
		// nothing to separate
	} else if (at === items.length) {
		const last = items.at(-1)!;
		if (last.separator) { // a trailing comma: the new item gets one too
			const comma = trail(Token.fromText(','), last.separator.trailingTrivia);
			trail(last.separator, space());
			item[setSlots]({ separator: comma });
		} else {
			const lastToken = last.getLastToken();
			const lineEnd = multiline && hasLineEnding(lastToken.trailingTrivia); // else the bracket closes the line of the last item
			trail(item.getLastToken(), lineEnd ? [new Trivia('LineEnding', eol)] : lastToken.trailingTrivia);
			const comma = trail(Token.fromText(','), lineEnd ? lastToken.trailingTrivia : multiline ? [new Trivia('LineEnding', eol)] : [new Trivia('Whitespace', ' ')]);
			trail(lastToken, []);
			last[setSlots]({ separator: comma });
		}
		if (multiline) {
			lead(item.getFirstToken(), indentTrivia(indentation));
		}
	} else {
		const next = items[at]!;
		const { preamble, owned } = splitLeading(next.getFirstToken().leadingTrivia);
		const comments = withoutIndentation(owned);
		const nextIndentation = startsLine(next) ? indentationOf(owned) : indentation;
		lead(item.getFirstToken(), [...preamble, ...indentTrivia(indentationOf(owned))]);
		lead(next.getFirstToken(), multiline ? [...comments, ...indentTrivia(nextIndentation)] : comments);
		item[setSlots]({ separator: trail(Token.fromText(','), space()) });
	}

	array[setItems]([...items.slice(0, at), item, ...items.slice(at)]);
	return item;
}


/** The indentation of the first item of an inline array that begins its line, or none. */
function itemIndentation(array: InlineArrayNode): string {
	return array.items.find(startsLine)?.getIndentation() ?? '';
}


/** Whether the items of an inline array stand on lines of their own. */
function isSpread(array: InlineArrayNode): boolean {
	return hasLineEnding(array.openBracket.trailingTrivia)
		|| array.items.some((item) => hasLineEnding(item.separator?.trailingTrivia ?? []));
}


// ---- removing


/** Removes the key at the path: the item found, and the items whose value it overwrote. */
export function removeByPath(document: DocumentNode, path: readonly PathSegment[], comments: CommentPolicy, nullable?: boolean, mergeBlankLines = false): void {
	const item = resolvePath(document, path);
	const array = item.parent as ArrayNode;
	if (typeof path.at(-1) === 'object') {
		removeItem(item, comments, nullable, mergeBlankLines);
		return;
	}
	const keys = itemKeys(array.items);
	const key = keys[array.items.indexOf(item)];
	for (const victim of array.items.filter((_, i) => keys[i] === key).reverse()) {
		removeItem(victim, comments, nullable, mergeBlankLines);
	}
}


/** Removes an item with the comments it owns. */
export function removeItem(item: ArrayItemNode, comments: CommentPolicy, nullable?: boolean, mergeBlankLines = false): void {
	const array = item.parent;
	if (!(array instanceof BlockArrayNode || array instanceof InlineArrayNode)) {
		throw new NeonError('The item is not in an array.');
	}

	const items = array.items;
	const index = items.indexOf(item);
	const remaining = items.filter((other) => other !== item);
	const owner = array.parent;
	const leaveNull = nullable ?? (owner instanceof ArrayItemNode || owner instanceof DocumentNode ? owner.nullable : false);
	const before = keysBefore(array);

	if (array instanceof BlockArrayNode && !remaining.length && owner instanceof DocumentNode) {
		emptyDocument(owner, item, comments, leaveNull);
		return;
	} else if (array instanceof BlockArrayNode) {
		removeFromBlock(item, comments, mergeBlankLines);
		if (!remaining.length) {
			emptyBlock(array, item, leaveNull);
			return;
		}
	} else {
		removeFromInline(array, item, index, comments);
		if (!remaining.length && leaveNull && owner instanceof ArrayItemNode) {
			array[setItems]([]);
			replaceValue(owner, null);
			return;
		} else if (!remaining.length && leaveNull && owner instanceof DocumentNode) {
			array[setItems]([]);
			emptyRoot(owner);
			return;
		}
	}
	array[setItems](remaining);
	keepKeys(array, before, true); // an item removed from a list renumbers the rest, whatever its key
	guardGrammar(array);
}


function removeFromBlock(item: ArrayItemNode, comments: CommentPolicy, mergeBlankLines: boolean): void {
	const { preamble, owned } = splitLeading(item.getFirstToken().leadingTrivia);
	const next = tokenAfter(item.getLastToken());
	const kept = comments === CommentPolicy.MoveToNextToken
		? [...withoutIndentation(owned), ...commentLine(item, Layout.indentation(item))]
		: [];
	const block = item.parent as BlockArrayNode;
	if (!startsLine(item)) { // the first item of a block opened on the line of a dash
		const second = block.items[1];
		const leading = second?.getFirstToken().leadingTrivia ?? [];
		if (second && (kept.length || leading.some((t) => t.kind === 'Comment'))) { // the dash ends its line, the comments stay below it
			trail((block.parent as ArrayItemNode).bullet!, [new Trivia('LineEnding', Layout.lineEnding(item))]);
			lead(second.getFirstToken(), joinTrivia(kept, leading));
		} else if (second) { // the next one moves up
			lead(second.getFirstToken(), []);
		}
	} else if (next && mergeBlankLines && !kept.length) { // the narrower of the two gaps stays
		const gap = Math.min(blankLines(preamble), blankLines(next.leadingTrivia, true));
		lead(next, joinTrivia(withoutBlankLines(preamble, gap), withoutBlankLines(next.leadingTrivia, 0, true)));
	} else if (next) {
		lead(next, joinTrivia([...preamble, ...kept], next.leadingTrivia));
	}
	if (!hasLineEnding(item.getLastToken().trailingTrivia) && next?.kind === 'EndOfFile' && !preamble.length && !kept.length) {
		const before = tokenBefore(item.getFirstToken());
		if (before) {
			trail(before, withoutLineEnding(before.trailingTrivia)); // the file keeps ending without a line ending
		}
	}
	lead(item.getFirstToken(), owned); // the item goes with what it owns, for insert()
}


/** The comment on the line of the item as a comment line of its own, for MoveToNextToken. */
function commentLine(item: ArrayItemNode, indent: string): Trivia[] {
	for (const token of item.getTokens()) {
		const comment = token.trailingTrivia.find((t) => t.kind === 'Comment');
		if (comment) {
			return [...indentTrivia(indent), comment, new Trivia('LineEnding', Layout.lineEnding(item))];
		} else if (hasLineEnding(token.trailingTrivia)) {
			break;
		}
	}
	return [];
}


/** The block lost its last item: an empty inline array takes its place, or null. */
function emptyBlock(block: BlockArrayNode, last: ArrayItemNode, leaveNull: boolean): void {
	const owner = block.parent as ArrayItemNode;
	const head = (owner.colon ?? owner.bullet)!;
	const onDashLine = !hasLineEnding(head.trailingTrivia); // then the line ending was the item's
	block[setItems]([]);
	owner[setSlots]({ value: null }); // the tokens of the block are gone, the head keeps its line ending
	if (onDashLine) {
		trail(head, last.getLastToken().trailingTrivia);
	}
	if (!leaveNull) {
		replaceValue(owner, emptyArray(last.key ? '{}' : '[]'));
	}
	guardGrammar(owner.parent);
}


/** The document lost its last item: the empty array, or nothing, keeps what stood above the item. */
function emptyDocument(document: DocumentNode, last: ArrayItemNode, comments: CommentPolicy, leaveNull: boolean): void {
	const { preamble, owned } = splitLeading(last.getFirstToken().leadingTrivia);
	const kept = [...preamble, ...comments === CommentPolicy.MoveToNextToken ? [...withoutIndentation(owned), ...commentLine(last, '')] : []];
	const trailing = last.getLastToken().trailingTrivia;
	(document.value as BlockArrayNode)[setItems]([]);
	if (leaveNull) {
		document[setSlots]({ value: null });
		lead(document.endOfFile, joinTrivia(kept, document.endOfFile.leadingTrivia));
		return;
	}
	const node = emptyArray(last.key ? '{}' : '[]');
	lead(node.getFirstToken(), kept);
	trail(node.getLastToken(), withoutComment(trailing)); // the comment on the line of the item went with it, or was kept above
	document[setSlots]({ value: node });
}


function emptyArray(brackets: string): ValueNode {
	return Builder.parse(brackets);
}


/**
 * Removes an item of an inline array. The item goes with what it owns; the lines around it stay lines:
 * an item that started its line takes the line ending before itself along, one that did not leaves
 * the line ending after itself, and what stood above the next item stays there.
 */
function removeFromInline(array: InlineArrayNode, item: ArrayItemNode, index: number, comments: CommentPolicy): void {
	const next = array.items[index + 1];
	const prev = array.items[index - 1];
	const first = item.getFirstToken();
	const eol = Layout.lineEnding(item);
	const { preamble, owned } = splitLeading(first.leadingTrivia);
	const ownLine = startsLine(item);
	const endsLine = item.getTokens().some((token) => hasLineEnding(token.trailingTrivia));
	const kept = comments === CommentPolicy.MoveToNextToken ? [...withoutIndentation(owned), ...commentLine(item, '')] : [];

	let before = tokenBefore(first)!; // the opening bracket, or the comma of the previous item
	let between: Trivia[];
	if (!next && prev?.separator && !item.separator) { // the comma before the last item goes with it
		const comma = prev.separator;
		prev[setSlots]({ separator: null });
		before = prev.getLastToken();
		between = [...before.trailingTrivia, ...ownLine ? comma.trailingTrivia : []];
	} else {
		between = ownLine || (next && !endsLine) ? [...before.trailingTrivia] : withoutTrailingSpace(before.trailingTrivia);
	}
	if (!ownLine && endsLine) {
		between = [...withoutTrailingSpace(between), new Trivia('LineEnding', eol)];
	}
	between.push(...preamble, ...kept);
	if (next && ownLine && !endsLine) { // the next item was on the line of the removed one
		between.push(...indentTrivia(indentationOf(owned)));
	}
	const after = next ? next.getFirstToken() : array.closeBracket;
	reattach(before, after, [...between, ...after.leadingTrivia]);
	item[setSlots]({ separator: null }); // the comma separated it in this array
	lead(first, owned); // the item goes with what it owns, for insert()
}


/** Splits the trivia between two tokens by the convention: up to the first line ending trailing, the rest leading. */
function reattach(before: Token, after: Token, trivia: readonly Trivia[]): void {
	const merged = joinAll(trivia);
	const split = merged.findIndex((t) => t.kind === 'LineEnding') + 1 || merged.length;
	trail(before, merged.slice(0, split));
	lead(after, merged.slice(split));
}


// ---- keys


/** Replaces the key of an item, in the quotes of the old one when it can be written in them; or by a key node. */
export function setItemKey(item: ArrayItemNode, key: string | StringNode | LiteralNode): void {
	const array = item.parent instanceof ArrayNode ? item.parent : null;
	const old = item.key;
	if (!old) {
		throw new NeonError('The item has no key.');
	} else if (typeof key !== 'string') {
		if (!(key instanceof StringNode || key instanceof LiteralNode) || key.token.text.includes('\n')) {
			throw new TypeError('A key is a StringNode or a LiteralNode on one line.');
		}
		checkPlaceable(item, key);
	} else if (item.getKeyValue() === key) {
		return;
	}
	const value = typeof key === 'string' ? key : key instanceof StringNode ? key.toValue() : literalKey(key.token.text);
	const found = array?.findItem(value);
	if (found && found !== item) {
		throw new NeonError(`Duplicated key '${value}'`);
	}

	const before = array && keysBefore(array);
	const node = typeof key !== 'string'
		? key
		: styledScalar(old, key) as StringNode | LiteralNode | null ?? (() => {
			const text = Builder.keyText(key);
			return text[0] === '\'' || text[0] === '"' ? string(text) : literal(text);
		})();
	takeEdges(node, old);
	item[setSlots]({ key: node });
	if (node instanceof LiteralNode && item.colon?.kind === 'Colon' && item.value && !item.colon.trailingTrivia.length) {
		trail(item.colon, [new Trivia('Whitespace', ' ')]); // `"a":b` stays two tokens, `a:b` would be one literal
	}
	if (array && before) {
		before.keys.set(item, value);
		keepKeys(array, before, false);
		guardGrammar(array);
	}
}


// ---- nodes in slots


/** Puts the node into the slot the old one stands in; the slot decides what that means. */
export function replaceNode(old: ValueNode, node: ValueNode): void {
	const parent = old.parent;
	if (node === old) {
		return;
	} else if (!(node instanceof ValueNode)) {
		throw new TypeError('ValueNode expected.');
	} else if (parent instanceof ArrayItemNode && parent.value === old) {
		setItemNode(parent, node);
	} else if (parent instanceof ArrayItemNode) {
		setItemKey(parent, node as StringNode | LiteralNode);
	} else if (parent instanceof DocumentNode) {
		setDocumentNode(parent, node);
	} else if (parent instanceof EntityNode && parent.value === old) {
		checkHead(node);
		if (parent.parent instanceof EntityChainNode && parent.parent.entities[0] !== parent && !(node instanceof LiteralNode)) {
			throw new TypeError('A link of a chain after the first has a literal head.');
		}
		checkPlaceable(parent, node);
		takeEdges(node, old);
		parent[setSlots]({ value: node });
	} else if (parent instanceof EntityNode) {
		checkAttributes(node as InlineArrayNode);
		checkPlaceable(parent, node);
		takeEdges(node, old);
		parent[setSlots]({ attributes: node as InlineArrayNode });
	} else if (parent instanceof EntityChainNode) {
		const entities = parent.entities.map((entity) => entity === old ? node as EntityNode : entity);
		checkLinks(entities);
		if (!(node as EntityNode).attributes && (old as EntityNode).attributes) {
			throw new TypeError('The link had parentheses, its replacement needs them too.');
		}
		checkMovable(parent, node);
		checkDepth(parent, node);
		takeEdges(node, old);
		parent[setSlots]({ entities });
	} else {
		throw new Error('The node is not in a tree.');
	}
}


/** The head of an entity is a scalar or an inline array, not the reserved name of a chain. */
function checkHead(node: ValueNode): void {
	checkNode(node, StringNode, LiteralNode, InlineArrayNode);
	if ((node instanceof StringNode ? node.toValue() : node instanceof LiteralNode ? node.token.text : null) === Chain) {
		throw new NeonError(`Entity name '${Chain}' is reserved`);
	}
}


function checkAttributes(node: InlineArrayNode): void {
	checkNode(node, InlineArrayNode);
	checkToken(node.openBracket, 'OpenParen');
}


/** The links after the first have a literal head, and only the last may be without parentheses. */
function checkLinks(entities: readonly EntityNode[]): void {
	entities.forEach((entity, i) => {
		checkNode(entity, EntityNode);
		if ((i > 0 && !(entity.value instanceof LiteralNode)) || (i < entities.length - 1 && !entity.attributes)) {
			throw new TypeError('A link of a chain after the first is a literal, and only the last one may be without parentheses.');
		}
	});
}


function checkToken(token: unknown, ...kinds: TokenKind[]): void {
	if (!(token instanceof Token) || !kinds.includes(token.kind)) {
		throw new TypeError(`A token ${kinds.join(' or ')} expected.`);
	}
}


function checkNode(node: unknown, ...types: NodeClass<Node>[]): void {
	if (!types.some((type) => node instanceof type)) {
		throw new TypeError(`${types.map((type) => type.name).join(' or ')} expected.`);
	}
}


/** Takes the node out of its slot with its edge trivia; only a value of an item with a head and the root can be empty. */
export function detachNode(node: ValueNode): void {
	const parent = node.parent;
	if (parent instanceof ArrayItemNode && parent.value === node && (parent.colon || parent.bullet)) {
		setItemNode(parent, null);
	} else if (parent instanceof DocumentNode) { // the preamble and the byte order mark stay in the document
		const first = node.getFirstToken();
		const { preamble, owned } = splitLeading(first.leadingTrivia);
		lead(first, owned);
		parent[setSlots]({ value: null });
		lead(parent.endOfFile, joinTrivia(preamble, parent.endOfFile.leadingTrivia));
	} else if (parent) {
		throw new Error('The slot of the node cannot be empty; use replaceWith().');
	}
}


/** Puts the node into the place of the root: a block gets the indentation of the old root block, or none. */
export function setDocumentNode(document: DocumentNode, node: ValueNode | null): void {
	const old = document.value;
	if (node === old) {
		return;
	} else if (!node) {
		emptyRoot(document);
		return;
	}
	if (!(node instanceof ValueNode)) {
		throw new TypeError('ValueNode expected.');
	}
	checkPlaceable(document, node);

	const end = document.endOfFile;
	if (node instanceof BlockArrayNode) {
		reindentBlock(node, old instanceof BlockArrayNode ? old.items[0]!.getIndentation() : '');
	}
	const first = node.getFirstToken();
	const blockLeading = node instanceof BlockArrayNode ? first.leadingTrivia : [];
	if (old) {
		const leading = old.getFirstToken().leadingTrivia;
		lead(first, node instanceof BlockArrayNode ? joinTrivia(withoutIndentation(leading), blockLeading) : leading);
		trail(node.getLastToken(), old.getLastToken().trailingTrivia);
	} else { // the first value of an empty document comes after what the document holds
		const leading = withoutIndentation(end.leadingTrivia);
		const eol = Layout.lineEnding(end);
		const lineEnding = leading.at(-1)?.kind === 'Comment' ? [new Trivia('LineEnding', eol)] : [];
		lead(first, joinTrivia([...leading, ...lineEnding], blockLeading));
		trail(node.getLastToken(), hasLineEnding(end.leadingTrivia) ? [new Trivia('LineEnding', eol)] : []);
		lead(end, []);
	}
	document[setSlots]({ value: node });
}


/** Empties the document; what stood above the value and the comment on its line stay. */
function emptyRoot(document: DocumentNode): void {
	const old = document.value;
	if (!old) {
		return;
	}
	const end = document.endOfFile;
	const trailing = old.getLastToken().trailingTrivia;
	const comment = trailing.filter((t) => t.kind === 'Comment');
	const kept = [
		...withoutIndentation(old.getFirstToken().leadingTrivia),
		...comment,
		...comment.length && (hasLineEnding(trailing) || end.leadingTrivia.length) ? [new Trivia('LineEnding', Layout.lineEnding(old))] : [],
	];
	document[setSlots]({ value: null });
	lead(end, joinTrivia(kept, end.leadingTrivia));
}


// ---- paths


/** The item at the path, or an error naming the first key that is not there. */
export function resolvePath(document: DocumentNode, path: readonly PathSegment[], fullPath = path): ArrayItemNode {
	let container: Node | null = document.value;
	let item: ArrayItemNode | null = null;
	path.forEach((segment) => {
		const array = arrayOf(container);
		item = !array ? null : typeof segment === 'object' ? array.items[segment.item] ?? null : array.findItem(segment);
		if (!item) {
			throw new NeonError(`No item '${segmentText(segment)}' in the path ${pathText(fullPath)}`);
		}
		container = item.value;
	});
	return item!;
}


/** The array of a container: the array itself, or the attributes of an entity. */
export function arrayOf(node: Node | null): ArrayNode | null {
	if (node instanceof EntityNode) {
		return node.attributes;
	}
	return node instanceof BlockArrayNode || node instanceof InlineArrayNode ? node : null;
}


export function setByPath(document: DocumentNode, path: readonly PathSegment[], value: unknown, create: boolean): void {
	if (!path.length) {
		setDocumentValue(document, value);
		return;
	}

	const last = path.at(-1)!;
	const owner = path.length > 1 ? resolvePath(document, path.slice(0, -1), path) : null;
	const container = owner ? owner.value : document.value;
	const array = arrayOf(container);
	const existing = array && (typeof last === 'object' ? array.items[last.item] : array.findItem(last));
	if (existing) {
		setItemValue(existing, value);
		return;
	} else if (!create || typeof last === 'object') { // an item by its order is never made
		const missing = `No item '${segmentText(last)}' in the path ${pathText(path)}`;
		throw new NeonError(create ? missing : missing + ', and create is false');
	}

	const key = String(last);
	if (array) {
		addItem(array, isImplicitKey(array, key) ? null : key, value);
	} else if (container === null && owner) {
		setItemValue(owner, new Map([[key, value]]));
	} else if (container === null && !owner) {
		setDocumentValue(document, new Map([[key, value]]));
	} else {
		throw new NeonError(`The value at ${pathText(path.slice(0, -1))} is not an array`);
	}
}


/** Whether a key is the one the array would assign to an item without a key. */
function isImplicitKey(array: ArrayNode, key: string): boolean {
	const length = listLength(array, itemKeys(array.items));
	return length !== null && String(length) === key;
}


function setDocumentValue(document: DocumentNode, value: unknown): void {
	const old = document.value;
	if (value instanceof ValueNode) {
		setDocumentNode(document, value);
	} else if (old ? sameValue(value, old) : value === null) {
		// nothing changes
	} else if (value === null) {
		emptyRoot(document);
	} else {
		const eol = Layout.lineEnding(document.endOfFile);
		setDocumentNode(document, styledScalar(old, value)
		?? Builder.value(value, { block: true, indent: '', unit: Layout.unit(document), eol, doubleQuoted: hasFragileString(document, value) }));
	}
}


function segmentText(segment: PathSegment): string {
	return typeof segment === 'object' ? `#${segment.item}` : String(segment);
}


function pathText(path: readonly PathSegment[]): string {
	return path.map(segmentText).join('.');
}


// ---- trivia


function lead(token: Token, trivia: readonly Trivia[]): Token {
	return token[setLeading](keepCarriageReturns(trivia));
}


function trail(token: Token, trivia: readonly Trivia[]): Token {
	return token[setTrailing](keepCarriageReturns(trivia));
}


/** A line feed put after a lone carriage return, which ends a comment or whitespace, is written as CRLF, so the CR stays its text. */
function keepCarriageReturns(trivia: readonly Trivia[]): readonly Trivia[] {
	return trivia.some((t, i) => t.text === '\n' && trivia[i - 1]?.text.endsWith('\r'))
		? trivia.map((t, i) => t.text === '\n' && trivia[i - 1]?.text.endsWith('\r') ? new Trivia('LineEnding', '\r\n') : t)
		: trivia;
}


/**
 * Splits the leading trivia of the first token of an item into the preamble (lines separated from
 * the item by a blank line, and the blank lines) and what the item owns: the comment lines directly
 * above it and its indentation.
 */
function splitLeading(trivia: readonly Trivia[]): { preamble: Trivia[]; owned: Trivia[] } {
	const lines = splitLines(trivia);
	let split = lines.length - 1; // the last line is the indentation
	while (split > 0 && lines[split - 1]!.some((t) => t.kind === 'Comment')) {
		split--;
	}
	const preamble = lines.slice(0, split).flat();
	const owned = lines.slice(split).flat();
	if (owned[0]?.kind === 'ByteOrderMark') { // the mark belongs to the start of the document
		preamble.push(owned.shift()!);
	}
	return { preamble, owned };
}


/** Number of blank lines at the end of the trivia, or at their start. */
function blankLines(trivia: readonly Trivia[], atStart = false): number {
	const lines = splitLines(trivia);
	if (!atStart) {
		lines.pop(); // the indentation of the line that follows
		lines.reverse();
	}
	let count = 0;
	while (lines[count]?.every((t) => t.kind !== 'Comment') && lines[count]!.some((t) => t.kind === 'LineEnding')) {
		count++;
	}
	return count;
}


/** The trivia with only the given number of blank lines left at the end, or at the start. */
function withoutBlankLines(trivia: readonly Trivia[], keep: number, atStart = false): Trivia[] {
	const lines = splitLines(trivia);
	const blank = blankLines(trivia, atStart);
	if (atStart) {
		lines.splice(keep, blank - keep);
	} else {
		lines.splice(lines.length - 1 - blank + keep, blank - keep);
	}
	return lines.flat();
}


/** Groups trivia into lines, each ending with its line ending; the last group has none. */
function splitLines(trivia: readonly Trivia[]): Trivia[][] {
	const lines: Trivia[][] = [[]];
	for (const t of trivia) {
		lines.at(-1)!.push(t);
		if (t.kind === 'LineEnding') {
			lines.push([]);
		}
	}
	return lines;
}


/** The comment lines without the indentation of the item they stood above. */
function withoutIndentation(owned: readonly Trivia[]): Trivia[] {
	const last = owned.at(-1);
	return last?.kind === 'Whitespace' ? owned.slice(0, -1) : [...owned];
}


function withoutTrailingSpace(trivia: readonly Trivia[]): Trivia[] {
	return trivia.at(-1)?.kind === 'Whitespace' ? trivia.slice(0, -1) : [...trivia];
}


/** The trivia without a comment and the space before it. */
function withoutComment(trivia: readonly Trivia[]): Trivia[] {
	const i = trivia.findIndex((t) => t.kind === 'Comment');
	const start = trivia[i - 1]?.kind === 'Whitespace' ? i - 1 : i;
	return i < 0 ? [...trivia] : joinAll([...trivia.slice(0, start), ...trivia.slice(i + 1)]);
}


function indentationOf(owned: readonly Trivia[]): string {
	const last = owned.at(-1);
	return last?.kind === 'Whitespace' ? last.text : '';
}


function indentTrivia(indent: string): Trivia[] {
	return indent ? [new Trivia('Whitespace', indent)] : [];
}


/** Concatenates two lists of trivia, merging whitespace that would meet. */
function joinTrivia(a: readonly Trivia[], b: readonly Trivia[]): Trivia[] {
	const last = a.at(-1);
	const first = b[0];
	if (last?.kind === 'Whitespace' && first?.kind === 'Whitespace') {
		return [...a.slice(0, -1), ...b];
	}
	return [...a, ...b];
}


function joinAll(trivia: readonly Trivia[]): Trivia[] {
	return trivia.reduce<Trivia[]>((res, t) => joinTrivia(res, [t]), []);
}


/**
 * Whether a multiline string of the value has to use """: the document holds an empty ''' string closed
 * on the line right after its opening, so a later line starting with ''' would close it instead.
 */
function hasFragileString(at: Node, value: unknown): boolean {
	if (!hasMultilineString(value)) {
		return false;
	}
	let root: Node = at;
	while (root.parent) {
		root = root.parent;
	}
	return root.getTokens().some((token) => token.kind === 'String' && /^'''\r?\n[\t ]*'''$/.test(token.text));
}


/** Whether the value holds a string the encoder writes on more lines; a value nested too deep or unknown counts as one. */
function hasMultilineString(value: unknown, depth = 0): boolean {
	if (typeof value === 'string') {
		return value.includes('\n');
	} else if (typeof value !== 'object' || value === null || value instanceof NeonDate) {
		return false;
	} else if (depth > MaxDepth) {
		return true;
	} else if (value instanceof Entity) {
		return hasMultilineString(value.value, depth + 1) || hasMultilineString(value.attributes, depth + 1);
	}
	const entries = entriesOf(value);
	return !entries || entries.entries.some(([, v]) => hasMultilineString(v, depth + 1));
}


/** Whether the item begins its line; not so the first item of a block opened on the line of a dash. */
function startsLine(item: ArrayItemNode): boolean {
	const before = tokenBefore(item.getFirstToken());
	return !before || hasLineEnding(before.trailingTrivia);
}


function hasLineEnding(trivia: readonly Trivia[]): boolean {
	return trivia.some((t) => t.kind === 'LineEnding');
}


function withoutLineEnding(trivia: readonly Trivia[]): Trivia[] {
	return trivia.filter((t) => t.kind !== 'LineEnding');
}


function tokenAfter(token: Token): Token | null {
	return findNeighbour(token, false);
}


function tokenBefore(token: Token): Token | null {
	return findNeighbour(token, true);
}
