import { NeonError } from './errors.ts';
import {
	arrayOf,
	addItem,
	CommentPolicy,
	detachNode,
	type PathSegment,
	removeByPath,
	removeItem,
	replaceNode,
	resolvePath,
	setByPath,
	setDocumentNode,
	setItemKey,
	setItemNode,
	setItemValue,
} from './editing.ts';
import { atomic, record, setItems, setParent, setSlots } from './internal.ts';
import { type Position, Token, type Trivia } from './token.ts';
import {
	Chain,
	Entity,
	EscapeError,
	evaluateString as evaluateStringText,
	evaluateLiteral,
	evaluateNumber,
	Int64Max,
	isIntegerKey,
	literalKey,
	type NeonValue,
} from './values.ts';


type Child = Node | Token;


export type NodeClass<T extends Node> = abstract new (...args: any[]) => T;


/** Base of all nodes of the syntax tree. */
export abstract class Node {
	#parent: Node | null = null;


	get parent(): Node | null {
		return this.#parent;
	}


	/** The slots in order, without nulls. */
	abstract getChildren(): Child[];


	/** A deep copy without a parent; tokens keep their origin. */
	abstract clone(): Node;


	getTokens(): Token[] {
		const res: Token[] = [];
		const collect = (node: Node) => {
			for (const child of node.getChildren()) {
				if (child instanceof Node) {
					collect(child);
				} else {
					res.push(child);
				}
			}
		};
		collect(this);
		return res;
	}


	abstract getFirstToken(): Token;


	abstract getLastToken(): Token;


	/** Current position of the first token, computed by a walk from the root. */
	getPosition(): Position | null {
		return this.getFirstToken().getPosition();
	}


	/** The source text of the node, with the trivia of its tokens. */
	print(): string {
		return this.getTokens().map(String).join('');
	}


	toString(): string {
		return this.print();
	}


	/** Whether the node spans more than one line, its outer trivia not counted. */
	isMultiLine(): boolean {
		const tokens = this.getTokens();
		return tokens.some((token, i) => (i > 0 && token.leadingTrivia.some((t) => t.kind === 'LineEnding'))
			|| /\n/.test(token.text)
			|| (i < tokens.length - 1 && token.trailingTrivia.some((t) => t.kind === 'LineEnding')));
	}


	hasLeadingComment(): boolean {
		return this.getLeadingComments().length > 0;
	}


	/** Comments in the leading trivia of the first token. */
	getLeadingComments(): Trivia[] {
		return this.getFirstToken().leadingTrivia.filter((t) => t.kind === 'Comment');
	}


	/** Comments in the trailing trivia of the last token. */
	getTrailingComments(): Trivia[] {
		return this.getLastToken().trailingTrivia.filter((t) => t.kind === 'Comment');
	}


	findAncestor<T extends Node>(type: NodeClass<T>): T | null {
		for (let node = this.#parent; node; node = node.parent) {
			if (node instanceof type) {
				return node;
			}
		}
		return null;
	}


	getNextSibling(): Node | null {
		const siblings = this.#siblings();
		return siblings[siblings.indexOf(this) + 1] ?? null;
	}


	getPreviousSibling(): Node | null {
		const siblings = this.#siblings();
		return siblings[siblings.indexOf(this) - 1] ?? null;
	}


	#siblings(): Node[] {
		return this.#parent?.getChildren().filter((child) => child instanceof Node) ?? [];
	}


	/** Descendants of the class, in document order. */
	find<T extends Node>(type: NodeClass<T>, predicate?: (node: T) => boolean): T[] {
		const res: T[] = [];
		this.#walk((node) => {
			if (node instanceof type && (!predicate || predicate(node))) {
				res.push(node);
			}
			return false;
		});
		return res;
	}


	findFirst<T extends Node>(type: NodeClass<T>, predicate?: (node: T) => boolean): T | null {
		let res: T | null = null;
		this.#walk((node) => {
			if (node instanceof type && (!predicate || predicate(node))) {
				res = node;
				return true;
			}
			return false;
		});
		return res;
	}


	/** Visits the descendants in document order until the visitor returns true. */
	#walk(visitor: (node: Node) => boolean): boolean {
		for (const child of this.getChildren()) {
			if (child instanceof Node && (visitor(child) || child.#walk(visitor))) {
				return true;
			}
		}
		return false;
	}


	/** @internal */
	[setParent](parent: Node | null): void {
		const old = this.#parent;
		record(() => this.#parent = old);
		this.#parent = parent;
	}
}


/** A node that has a value. */
export abstract class ValueNode extends Node {
	abstract toValue(): NeonValue;


	abstract override clone(): ValueNode;


	/** Puts the node into the slot of this one, which decides what that means; the node gets the trivia at the edges of this one in place of its own. */
	replaceWith(node: ValueNode): void {
		atomic(() => replaceNode(this, node));
	}


	/** Takes the node out of the tree, with the trivia at its edges; the emptied slot gets null. */
	detach(): this {
		atomic(() => detachNode(this));
		return this;
	}
}


/** Puts a child into a slot of the parent and releases the previous one. */
function adopt<T extends Child | null>(parent: Node, child: T, previous: Child | null = null): T {
	if (child === previous) {
		return child;
	} else if (child) {
		if (child.parent) {
			throw new Error('The node already has a parent, detach() or clone() it first.');
		}
		for (let node: Node | null = parent; node; node = node.parent) {
			if (node === (child as Child)) {
				throw new Error('A node cannot be put into its own subtree.');
			}
		}
		child[setParent](parent);
	}
	previous?.[setParent](null);
	return child;
}


export class DocumentNode extends Node {
	#value: ValueNode | null = null;
	#endOfFile: Token;

	/** Whether removing the last item leaves null instead of an empty collection. */
	nullable = false;


	/** @internal */
	constructor(value: ValueNode | null, endOfFile: Token) {
		super();
		this.#value = adopt(this, value);
		this.#endOfFile = adopt(this, endOfFile);
	}


	get value(): ValueNode | null {
		return this.#value;
	}


	/** The same as setValue([], node): the node takes the place of the root, null empties the document. */
	set value(node: ValueNode | null) {
		atomic(() => setDocumentNode(this, node));
	}


	get endOfFile(): Token {
		return this.#endOfFile;
	}


	getChildren(): Child[] {
		return this.#value ? [this.#value, this.#endOfFile] : [this.#endOfFile];
	}


	getFirstToken(): Token {
		return this.#value?.getFirstToken() ?? this.#endOfFile;
	}


	getLastToken(): Token {
		return this.#endOfFile;
	}


	clone(): DocumentNode {
		const res = new DocumentNode(this.#value?.clone() ?? null, this.#endOfFile.clone());
		res.nullable = this.nullable;
		return res;
	}


	toValue(): NeonValue {
		return this.#value?.toValue() ?? null;
	}


	/** The item at the path of keys, the same keys decode() gives; a path continues into the attributes of an entity. */
	findItem(path: readonly PathSegment[]): ArrayItemNode | null {
		try {
			return path.length ? resolvePath(this, path) : null;
		} catch (e) {
			if (e instanceof NeonError) {
				return null;
			}
			throw e;
		}
	}


	/** Writes the value at the path; a missing last key is added, unless create is false. */
	setValue(path: readonly PathSegment[], value: unknown, options: { create?: boolean } = {}): void {
		atomic(() => setByPath(this, path, value, options.create ?? true));
	}


	/** Adds an item to the array at the path, without a key unless given one. */
	addItem(path: readonly PathSegment[], value: unknown, options: { key?: string; position?: number } = {}): ArrayItemNode {
		return atomic(() => {
			const owner = path.length ? resolvePath(this, path) : null;
			const container = owner ? owner.value : this.#value;
			const array = arrayOf(container);
			if (array) {
				return addItem(array, options.key ?? null, value, options.position);
			} else if (container === null) {
				if (options.position !== undefined && options.position !== 0) {
					throw new RangeError(`Position ${options.position} is out of the array.`);
				}
				const key = options.key ?? null;
				const placeholder = value instanceof ValueNode ? null : value; // a node comes into the item as into any other
				setByPath(this, path, key === null ? [placeholder] : new Map([[key, placeholder]]), true);
				const item = (arrayOf(owner ? owner.value : this.#value) as ArrayNode).items[0]!;
				if (value instanceof ValueNode) {
					item.setValue(value);
				}
				return item;
			}
			throw new NeonError(`The value at ${path.join('.')} is not an array`);
		});
	}


	/** Removes the item at the path with the comments it owns. */
	removeItem(path: readonly PathSegment[], options: { comments?: CommentPolicy; nullable?: boolean; mergeBlankLines?: boolean } = {}): void {
		atomic(() => removeByPath(this, path, options.comments ?? CommentPolicy.Drop, options.nullable, options.mergeBlankLines));
	}


	/** Renames the key of the item at the path. */
	setKey(path: readonly PathSegment[], key: string): void {
		atomic(() => setItemKey(resolvePath(this, path), key));
	}


	/** @internal Writes the slot as it is, for an edit that moves the trivia itself. */
	[setSlots](slots: { value: ValueNode | null }): void {
		const old = this.#value;
		this.#value = adopt(this, slots.value, old);
		record(() => this.#value = old);
	}
}


/** Base of the two kinds of arrays. */
export abstract class ArrayNode extends ValueNode {
	#items: readonly ArrayItemNode[] = [];


	get items(): readonly ArrayItemNode[] {
		return this.#items;
	}


	/** Whether the array without items is a map, `{}`. */
	protected abstract isEmptyMap(): boolean;


	/** @internal Replaces the list; items that leave it lose their parent, new ones must have none. */
	[setItems](items: readonly ArrayItemNode[]): void {
		const old = this.#items;
		const kept = new Set(items);
		const present = new Set(old);
		for (const item of old) {
			if (!kept.has(item)) {
				item[setParent](null);
			}
		}
		for (const item of items) {
			if (!present.has(item)) {
				adopt(this, item);
			}
		}
		this.#items = Object.freeze([...items]);
		record(() => this.#items = old);
	}


	/** The item with the canonical key, as decode() would find it. */
	findItem(key: string | number): ArrayItemNode | null {
		const map = resolveKeys(this.items);
		return map.get(String(key)) ?? null;
	}


	/** Adds an item built from the value, at the end or before the item at the position. */
	addItem(value: unknown, options: { key?: string; position?: number } = {}): ArrayItemNode {
		return atomic(() => addItem(this, options.key ?? null, value, options.position));
	}


	/** Removes the item with the comments it owns. */
	removeItem(item: ArrayItemNode, comments: CommentPolicy = CommentPolicy.Drop): void {
		if (item.parent !== this) {
			throw new Error('The item is not in this array.');
		}
		atomic(() => removeItem(item, comments));
	}


	toValue(): NeonValue {
		const entries = (new Map<string, NeonValue>);
		for (const [key, item] of resolveKeys(this.items)) {
			entries.set(key, item.getValue());
		}

		const keys = [...entries.keys()];
		if (!keys.length) {
			return this.isEmptyMap() ? {} : [];
		} else if (keys.every((key, i) => key === String(i))) {
			return [...entries.values()];
		}

		const res: { [key: string]: NeonValue } = {};
		for (const [key, value] of entries) {
			Object.defineProperty(res, key, { value, writable: true, enumerable: true, configurable: true });
		}
		return res;
	}
}


/** Keys of the items with implicit keys assigned; for overwritten keys the winning item, at the first position. */
function resolveKeys(items: readonly ArrayItemNode[]): Map<string, ArrayItemNode> {
	const keys = itemKeys(items);
	return new Map(items.map((item, i) => [keys[i]!, item]));
}


/** The key of each item, explicit or implicit. */
export function itemKeys(items: readonly ArrayItemNode[]): string[] {
	let max: bigint | null = null;
	return items.map((item) => {
		let key = item.getKeyValue();
		if (key === null) {
			const next: bigint = max === null ? 0n : max + 1n;
			if (next > Int64Max) {
				throw new NeonError('Implicit key overflow', item.getPosition());
			}
			key = String(next);
		}
		if (isIntegerKey(key)) {
			const n = BigInt(key);
			max = max === null || n > max ? n : max;
		}
		return key;
	});
}


export class BlockArrayNode extends ArrayNode {
	/** @internal */
	constructor(items: readonly ArrayItemNode[]) {
		super();
		this[setItems](items);
	}


	protected isEmptyMap(): boolean {
		return false;
	}


	getChildren(): Child[] {
		return [...this.items];
	}


	getFirstToken(): Token {
		return this.items[0]!.getFirstToken();
	}


	getLastToken(): Token {
		return this.items.at(-1)!.getLastToken();
	}


	clone(): BlockArrayNode {
		return new BlockArrayNode(this.items.map((item) => item.clone()));
	}
}


export class InlineArrayNode extends ArrayNode {
	#openBracket: Token;
	#closeBracket: Token;


	/** @internal */
	constructor(openBracket: Token, items: readonly ArrayItemNode[], closeBracket: Token) {
		super();
		this.#openBracket = adopt(this, openBracket);
		this[setItems](items);
		this.#closeBracket = adopt(this, closeBracket);
	}


	protected isEmptyMap(): boolean {
		return this.#openBracket.kind === 'OpenBrace';
	}


	get openBracket(): Token {
		return this.#openBracket;
	}


	get closeBracket(): Token {
		return this.#closeBracket;
	}


	getChildren(): Child[] {
		return [this.#openBracket, ...this.items, this.#closeBracket];
	}


	getFirstToken(): Token {
		return this.#openBracket;
	}


	getLastToken(): Token {
		return this.#closeBracket;
	}


	clone(): InlineArrayNode {
		return new InlineArrayNode(this.#openBracket.clone(), this.items.map((item) => item.clone()), this.#closeBracket.clone());
	}
}


export class ArrayItemNode extends Node {
	#bullet: Token | null;
	#key: StringNode | LiteralNode | null;
	#colon: Token | null;
	#value: ValueNode | null;
	#separator: Token | null;

	/** Whether removing the last item of the value leaves null instead of an empty collection. */
	nullable = false;


	/** @internal */
	constructor(
		bullet: Token | null,
		key: StringNode | LiteralNode | null,
		colon: Token | null,
		value: ValueNode | null,
		separator: Token | null = null,
	) {
		super();
		this.#bullet = adopt(this, bullet);
		this.#key = adopt(this, key);
		this.#colon = adopt(this, colon);
		this.#value = adopt(this, value);
		this.#separator = adopt(this, separator);
	}


	get bullet(): Token | null {
		return this.#bullet;
	}


	get key(): StringNode | LiteralNode | null {
		return this.#key;
	}


	get colon(): Token | null {
		return this.#colon;
	}


	get value(): ValueNode | null {
		return this.#value;
	}


	/** The same as setValue(node) with a node: the node takes the place of the value, null empties it. */
	set value(node: ValueNode | null) {
		atomic(() => setItemNode(this, node));
	}


	get separator(): Token | null {
		return this.#separator;
	}


	/** @internal Writes the slots as they are, for an edit that moves the trivia itself. */
	[setSlots](slots: { bullet?: Token | null; key?: StringNode | LiteralNode | null; colon?: Token | null; value?: ValueNode | null; separator?: Token | null }): void {
		const old = [this.#bullet, this.#key, this.#colon, this.#value, this.#separator] as const;
		record(() => [this.#bullet, this.#key, this.#colon, this.#value, this.#separator] = old);
		if (slots.bullet !== undefined) {
			this.#bullet = adopt(this, slots.bullet, this.#bullet);
		}
		if (slots.key !== undefined) {
			this.#key = adopt(this, slots.key, this.#key);
		}
		if (slots.colon !== undefined) {
			this.#colon = adopt(this, slots.colon, this.#colon);
		}
		if (slots.value !== undefined) {
			this.#value = adopt(this, slots.value, this.#value);
		}
		if (slots.separator !== undefined) {
			this.#separator = adopt(this, slots.separator, this.#separator);
		}
	}


	getChildren(): Child[] {
		return [this.#bullet, this.#key, this.#colon, this.#value, this.#separator].filter((child) => child !== null);
	}


	getFirstToken(): Token {
		return this.#bullet ?? this.#key?.getFirstToken() ?? this.#value!.getFirstToken();
	}


	getLastToken(): Token {
		return this.#separator ?? this.#value?.getLastToken() ?? this.#colon ?? this.#bullet!;
	}


	clone(): ArrayItemNode {
		const res = new ArrayItemNode(
			this.#bullet?.clone() ?? null,
			this.#key?.clone() ?? null,
			this.#colon?.clone() ?? null,
			this.#value?.clone() ?? null,
			this.#separator?.clone() ?? null,
		);
		res.nullable = this.nullable;
		return res;
	}


	/** The canonical key, or null for an item without a key. */
	getKeyValue(): string | null {
		const key = this.#key;
		return key instanceof StringNode
			? key.toValue()
			: key ? literalKey(key.token.text) : null;
	}


	/** The value of the item, null without one. */
	getValue(): NeonValue {
		return this.#value?.toValue() ?? null;
	}


	/** The indentation of the line the item starts on. */
	getIndentation(): string {
		const trivia = this.getFirstToken().leadingTrivia.at(-1);
		return trivia?.kind === 'Whitespace' ? trivia.text : '';
	}


	/**
	 * Writes the value: a value of the host or a node. Writing an equal value changes nothing; a new
	 * scalar keeps the style of the old one where it can.
	 */
	setValue(value: unknown): void {
		atomic(() => setItemValue(this, value));
	}


	/** Renames the key. */
	setKey(key: string): void {
		atomic(() => setItemKey(this, key));
	}


	/** Removes the item from its array, with the comments it owns. */
	remove(comments: CommentPolicy = CommentPolicy.Drop, mergeBlankLines = false): void {
		atomic(() => removeItem(this, comments, undefined, mergeBlankLines));
	}
}


export class EntityNode extends ValueNode {
	#value: ValueNode;
	#attributes: InlineArrayNode | null;


	/** @internal */
	constructor(value: ValueNode, attributes: InlineArrayNode | null) {
		super();
		this.#value = adopt(this, value);
		this.#attributes = adopt(this, attributes);
	}


	get value(): ValueNode {
		return this.#value;
	}


	get attributes(): InlineArrayNode | null {
		return this.#attributes;
	}


	/** @internal */
	[setSlots](slots: { value?: ValueNode; attributes?: InlineArrayNode }): void {
		const old = [this.#value, this.#attributes] as const;
		record(() => [this.#value, this.#attributes] = old);
		if (slots.value) {
			this.#value = adopt(this, slots.value, this.#value);
		}
		if (slots.attributes) {
			this.#attributes = adopt(this, slots.attributes, this.#attributes);
		}
	}


	getChildren(): Child[] {
		return this.#attributes ? [this.#value, this.#attributes] : [this.#value];
	}


	getFirstToken(): Token {
		return this.#value.getFirstToken();
	}


	getLastToken(): Token {
		return this.#attributes?.closeBracket ?? this.#value.getLastToken();
	}


	clone(): EntityNode {
		return new EntityNode(this.#value.clone(), this.#attributes?.clone() ?? null);
	}


	toValue(): Entity {
		const attributes = this.#attributes?.toValue() ?? [];
		return new Entity(this.#value.toValue(), attributes as Entity['attributes']);
	}
}


export class EntityChainNode extends ValueNode {
	#entities: readonly EntityNode[];


	/** @internal */
	constructor(entities: readonly EntityNode[]) {
		super();
		this.#entities = Object.freeze([...entities]);
		for (const entity of entities) {
			adopt(this, entity);
		}
	}


	get entities(): readonly EntityNode[] {
		return this.#entities;
	}


	/** @internal */
	[setSlots](slots: { entities: readonly EntityNode[] }): void {
		const old = this.#entities;
		for (const entity of old) {
			if (!slots.entities.includes(entity)) {
				entity[setParent](null);
			}
		}
		for (const entity of slots.entities) {
			if (!old.includes(entity)) {
				adopt(this, entity);
			}
		}
		this.#entities = Object.freeze([...slots.entities]);
		record(() => this.#entities = old);
	}


	getChildren(): Child[] {
		return [...this.#entities];
	}


	getFirstToken(): Token {
		return this.#entities[0]!.getFirstToken();
	}


	getLastToken(): Token {
		return this.#entities.at(-1)!.getLastToken();
	}


	clone(): EntityChainNode {
		return new EntityChainNode(this.#entities.map((entity) => entity.clone()));
	}


	toValue(): Entity {
		return new Entity(Chain, this.#entities.map((entity) => entity.toValue()));
	}
}


export class StringNode extends ValueNode {
	#token: Token;


	/** @internal */
	constructor(token: Token) {
		super();
		this.#token = adopt(this, token);
	}


	get token(): Token {
		return this.#token;
	}


	getChildren(): Child[] {
		return [this.#token];
	}


	getFirstToken(): Token {
		return this.#token;
	}


	getLastToken(): Token {
		return this.#token;
	}


	clone(): StringNode {
		return new StringNode(this.#token.clone());
	}


	toValue(): string {
		return evaluateStringToken(this.#token);
	}
}


export class LiteralNode extends ValueNode {
	#token: Token;


	/** @internal */
	constructor(token: Token) {
		super();
		this.#token = adopt(this, token);
	}


	get token(): Token {
		return this.#token;
	}


	getChildren(): Child[] {
		return [this.#token];
	}


	getFirstToken(): Token {
		return this.#token;
	}


	getLastToken(): Token {
		return this.#token;
	}


	clone(): LiteralNode {
		return new LiteralNode(this.#token.clone());
	}


	/** The value of the literal; a key keeps words and dates as strings. */
	toValue(isKey = false): NeonValue {
		const text = this.#token.text;
		return isKey ? evaluateNumber(text) ?? text : evaluateLiteral(text);
	}
}


function evaluateStringToken(token: Token): string {
	try {
		return evaluateStringText(token.text);
	} catch (e) {
		if (e instanceof EscapeError) {
			throw new NeonError(e.message, token.getPosition() ?? token.origin);
		}
		throw e;
	}
}
