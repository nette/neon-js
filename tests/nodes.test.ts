import { describe, expect, test } from 'vitest';
import {
	ArrayItemNode,
	BlockArrayNode,
	DocumentNode,
	EntityNode,
	InlineArrayNode,
	LiteralNode,
	Node,
	StringNode,
} from '../src/nodes.ts';
import { parse } from '../src/parser.ts';
import { locateAll, printText } from '../src/printer.ts';
import { Token, Trivia } from '../src/token.ts';
import { loadCases } from './corpus.ts';


/** Parents agree with a walk of the tree, and every token stands once. */
function checkParents(document: DocumentNode): void {
	const seen = (new Set<Token>);
	const walk = (node: Node) => {
		for (const child of node.getChildren()) {
			expect(child.parent).toBe(node);
			if (child instanceof Node) {
				walk(child);
			} else {
				expect(seen.has(child)).toBe(false);
				seen.add(child);
			}
		}
	};
	expect(document.parent).toBeNull();
	walk(document);
}


test('parents over the corpus', () => {
	for (const c of [...loadCases('roundtrip'), ...loadCases('decode')]) {
		checkParents(parse(c.read('.neon')!));
	}
});


const config = `# database
database:
	dsn: 'mysql:host=127.0.0.1' # local
	user: root
	options: [lazy: yes, 0x10]

services:
	- Foo(@bar)
`;


test('navigation', () => {
	const document = parse(config);
	const root = document.value as BlockArrayNode;
	expect(root).toBeInstanceOf(BlockArrayNode);

	const user = document.findItem(['database', 'user'])!;
	expect(user).toBeInstanceOf(ArrayItemNode);
	expect(user.getKeyValue()).toBe('user');
	expect(user.getValue()).toBe('root');
	expect(user.getIndentation()).toBe('\t');
	expect(user.findAncestor(DocumentNode)).toBe(document);
	expect(user.getPreviousSibling()!.getFirstToken().text).toBe('dsn');
	expect((user.getNextSibling() as ArrayItemNode).getKeyValue()).toBe('options');

	const options = document.findItem(['database', 'options'])!;
	expect(options.value).toBeInstanceOf(InlineArrayNode);
	expect(document.findItem(['database', 'options', 0])!.getValue()).toBe(16);
	expect(document.findItem(['database', 'options', 'lazy'])!.getValue()).toBe(true);
	expect(document.findItem(['services', 0])!.value).toBeInstanceOf(EntityNode);
	expect(document.findItem(['services', { item: 0 }])).toBe(document.findItem(['services', 0]));
	expect(document.findItem(['nope'])).toBeNull();
	expect(document.findItem(['database', 'user', 'x'])).toBeNull();

	expect(document.find(StringNode).map((node) => node.toValue())).toEqual(['mysql:host=127.0.0.1']);
	expect(document.findFirst(LiteralNode, (node) => node.token.text === 'root')?.toValue()).toBe('root');

	const dsn = document.findItem(['database', 'dsn'])!;
	expect(dsn.getTrailingComments().map((t) => t.getCommentText())).toEqual(['local']);
	expect(root.items[0]!.getLeadingComments().map((t) => t.text)).toEqual(['# database']);
	expect(root.items[0]!.hasLeadingComment()).toBe(true);
	expect(root.items[0]!.isMultiLine()).toBe(true);
	expect(dsn.isMultiLine()).toBe(false);
	expect(printText(dsn)).toBe('dsn: \'mysql:host=127.0.0.1\'');
});


test('positions are computed from the current tree', () => {
	const document = parse(config);
	const user = document.findItem(['database', 'user'])!;
	const offset = config.indexOf('user');
	expect(user.getPosition()).toEqual({ line: 4, column: 2, offset, utf16Offset: offset });
	expect(user.getFirstToken().origin).toEqual(user.getPosition());

	const all = locateAll(document);
	for (const token of document.getTokens()) {
		expect(all.get(token)).toEqual(token.origin);
	}

	const dsn = document.findItem(['database', 'dsn'])!;
	(dsn.value as StringNode).token.setText('\'x\'');
	const shift = '\'mysql:host=127.0.0.1\''.length - 3;
	expect(user.getPosition()).toEqual({ line: 4, column: 2, offset: offset - shift, utf16Offset: offset - shift });
	expect(user.getFirstToken().origin!.offset).toBe(offset);
});


describe('slots keep the tree consistent', () => {
	test('a node stands in one place', () => {
		const document = parse('a: 1\nb: 2');
		const [a, b] = (document.value as BlockArrayNode).items as [ArrayItemNode, ArrayItemNode];
		expect(() => {
			a.value = b.value;
		}).toThrow('already has a parent');
		expect(document.print()).toBe('a: 1\nb: 2');

		const old = a.value!;
		a.value = parse('3').value!.detach();
		expect(old.parent).toBeNull();
		expect(document.toValue()).toEqual({ a: 3, b: 2 });
	});

	test('no node into its own subtree', () => {
		const document = parse('[b]');
		const inline = document.value as InlineArrayNode;
		document.value = null;
		expect(() => {
			inline.items[0]!.value = inline;
		}).toThrow('own subtree');
	});

	test('lists are read-only', () => {
		const document = parse('[a, b]');
		const items = (document.value as InlineArrayNode).items;
		expect(Object.isFrozen(items)).toBe(true);
		expect((document.value as InlineArrayNode).items).toBe(items);
	});
});


test('values of the tree', () => {
	const keys = parse('{__proto__: 1, constructor: 2, toString: 3}').toValue() as Record<string, unknown>;
	expect(Object.entries(keys)).toEqual([['__proto__', 1], ['constructor', 2], ['toString', 3]]);
	const value = parse('{__proto__: {polluted: 1}}').toValue() as Record<string, unknown>;
	expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
	expect(Object.keys(value)).toEqual(['__proto__']);
	expect(({} as Record<string, unknown>).polluted).toBeUndefined();

	expect(parse('[9007199254740991, 9007199254740992, 0xffffffffffffffffffff]').toValue())
		.toEqual([9007199254740991, 9007199254740992n, 0xffffffffffffffffffffn]);
	expect(parse('{2: a, 1: b}').toValue()).toEqual({ 1: 'b', 2: 'a' });
	expect(parse('[]').toValue()).toEqual([]);
	expect(parse('{}').toValue()).toEqual({});
	expect(parse('').toValue()).toBeNull();
});


test('first editing slice: a scalar changes and nothing else', () => {
	const input = '﻿# config\r\nparameters:\r\n\tkey: 0x10 # hex\r\n\tother: [a, b] # inline\r\nlast: 1';
	const document = parse(input);
	const token = (document.findItem(['parameters', 'key'])!.value as LiteralNode).token;
	token.setText('0x20');
	expect(document.print()).toBe(input.replace('0x10', '0x20'));
	expect(document.toValue()).toEqual({ parameters: { key: 32, other: ['a', 'b'] }, last: 1 });
});


test('an instance of trivia stands in a list once, so that replaceTrivia() replaces the one meant', () => {
	const document = parse('a: 1\nb: 2\n');
	const token = document.findItem(['b'])!.key!.getFirstToken();
	const eol = Trivia.fromText('\n');
	token.setLeadingTrivia([eol, eol]);
	expect(token.leadingTrivia[0]).not.toBe(token.leadingTrivia[1]);
	token.replaceTrivia(eol, Trivia.fromText('\r\n'));
	expect(document.print()).toBe('a: 1\n\r\n\nb: 2\n');
});
