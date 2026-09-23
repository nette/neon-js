import { describe, expect, test } from 'vitest';
import {
	DocumentNode,
	InlineArrayNode,
	Node,
} from '../src/nodes.ts';
import { parse } from '../src/parser.ts';
import { Token } from '../src/token.ts';
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


describe('slots keep the tree consistent', () => {
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
