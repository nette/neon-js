import { describe, expect, test } from 'vitest';
import { CommentPolicy } from '../src/editing.ts';
import {
	ArrayItemNode,
	BlockArrayNode,
	type DocumentNode,
	EntityChainNode,
	EntityNode,
	InlineArrayNode,
	type ValueNode,
} from '../src/nodes.ts';
import { parse } from '../src/parser.ts';
import { Token, Trivia } from '../src/token.ts';
import { Entity, NeonDate } from '../src/values.ts';
import { checkTree, snapshot } from './guarantees.ts';


// Targeted cases of the editing API: the slots, the root, the refused operations and the low level.

function detached(text: string): ValueNode {
	return parse(text).value!.detach();
}


function expectRefused(operation: () => unknown, message: RegExp | string, ...nodes: DocumentNode[]): void {
	const unchanged = snapshot(...nodes);
	expect(operation).toThrow(message);
	unchanged();
	nodes.forEach(checkTree);
}


describe('slots', () => {
	test('a block cannot come into an inline array, through any door', () => {
		const doc = parse('[a]');
		const donor = parse('x: 1\n');
		const block = donor.value!;
		expectRefused(() => (doc.value as InlineArrayNode).items[0]!.value = block, 'block', doc, donor);
		expectRefused(() => (doc.value as InlineArrayNode).addItem(block), 'block', doc, donor);
		expectRefused(() => (doc.value as InlineArrayNode).items[0]!.value!.replaceWith(block), 'block', doc, donor);
	});

	test('a public slot setter is the editing operation: a block is reindented under its key', () => {
		const doc = parse('a: 1\nb: 2\n');
		doc.findItem(['a'])!.value = detached('x: 1\ny: 2\n');
		expect(doc.print()).toBe('a:\n\tx: 1\n\ty: 2\nb: 2\n');
		checkTree(doc);

		doc.findItem(['b'])!.value = detached('- p\n- q\n');
		expect(doc.print()).toBe('a:\n\tx: 1\n\ty: 2\nb:\n\t- p\n\t- q\n');
		checkTree(doc);

		const list = parse('- 1\n- 2\n');
		list.addItem([], detached('k: v\nl: w\n'));
		expect(list.print()).toBe('- 1\n- 2\n-\n\tk: v\n\tl: w\n');
		checkTree(list);
	});

	test('replaceWith() is decided by the slot', () => {
		const doc = parse('a: 1\n');
		doc.findItem(['a'])!.key!.replaceWith(detached('b'));
		expect(doc.print()).toBe('b: 1\n');

		const entity = parse('x: a(1)\n');
		const node = entity.findItem(['x'])!.value as EntityNode;
		node.value.replaceWith(detached('b'));
		expect(entity.print()).toBe('x: b(1)\n');
		expectRefused(() => node.value.replaceWith(detached('\'!!chain\'')), 'reserved', entity);
		node.attributes!.replaceWith((parse('c(2, 3)').value as EntityNode).attributes!.clone());
		expect(entity.print()).toBe('x: b(2, 3)\n');
		checkTree(entity);

		const chain = parse('a()b()\n');
		const links = (chain.value as EntityChainNode).entities;
		links[1]!.replaceWith(detached('c(1)'));
		expect(chain.print()).toBe('a()c(1)\n');
		expectRefused(() => links[0]!.replaceWith(detached('d')), 'EntityNode', chain);
		expectRefused(() => (chain.value as EntityChainNode).entities[1]!.value.replaceWith(detached('\'q\'')), 'literal', chain);
	});

	test('a literal key gets a space after its colon, an inserted item its value on the line of the key', () => {
		const doc = parse('{"a":b}');
		(doc.value as InlineArrayNode).items[0]!.key!.replaceWith(detached('new'));
		expect(doc.print()).toBe('{new: b}');
		checkTree(doc);

		const source = parse('b:\n  two words\nc: 1\n');
		const item = source.findItem(['b'])!;
		item.remove();
		const target = parse('E(a: 1)');
		(target.value as EntityNode).attributes!.insert(0, item);
		expect(target.print()).toBe('E(b: two words, a: 1)');
		checkTree(target);
	});

	test('slots that cannot be empty refuse detach()', () => {
		const doc = parse('a: b(1)\n');
		expectRefused(() => doc.findItem(['a'])!.key!.detach(), 'cannot be empty', doc);
		expectRefused(() => (doc.findItem(['a'])!.value as EntityNode).value.detach(), 'cannot be empty', doc);
		const inline = parse('[a]');
		expectRefused(() => (inline.value as InlineArrayNode).items[0]!.value = null, 'cannot be empty', inline);
	});

	test('detaching the root leaves the preamble and the byte order mark', () => {
		const bom = String.fromCharCode(0xFEFF);
		const doc = parse(bom + '# license\n\n# about a\na: 1\n');
		const node = doc.value!.detach();
		expect(doc.print()).toBe(bom + '# license\n\n');
		expect(node.print()).toBe('# about a\na: 1\n');
		checkTree(doc);
	});
});


describe('root', () => {
	test('a block at the root has the indentation of the old root block, or none', () => {
		const crlf = parse('42\r\n');
		crlf.setValue([], { a: 1, b: 2 });
		expect(crlf.print()).toBe('a: 1\r\nb: 2\r\n');

		const indented = parse('  a: 1\n  b: 2\n');
		indented.setValue([], new Map<string, unknown>([['x', [1, 2]], ['y', 2]]));
		expect(indented.print()).toBe('  x:\n  \t- 1\n  \t- 2\n\n  y: 2\n');
		checkTree(indented);

		const scalar = parse('# c\na: 1\nb: 2\n');
		scalar.setValue([], 'text');
		expect(scalar.print()).toBe('# c\ntext\n');
	});

	test('an empty document', () => {
		for (const [input, value, output] of [
			['', { a: 1, b: 2 }, 'a: 1\nb: 2'],
			['  ', 1, '1'],
			['\n\n', 1, '\n\n1\n'],
			['# a\n\n# b\n', [1], '# a\n\n# b\n- 1\n'],
		] as const) {
			const doc = parse(input);
			doc.setValue([], value);
			expect(doc.print(), JSON.stringify(input)).toBe(output);
			checkTree(doc);
		}
	});

	test('the first item comes into an empty place as any other', () => {
		for (const input of ['', 'a:\n']) {
			const path = input ? ['a'] : [];
			let doc = parse(input);
			doc.addItem(path, detached('[x]'), { key: 'k' });
			expect(doc.print()).toBe(input ? 'a:\n\tk: [x]\n' : 'k: [x]');
			checkTree(doc);

			doc = parse(input);
			expect(() => doc.addItem(path, 1, { position: 1 })).toThrow('Position 1 is out of the array.');
			expect(doc.print()).toBe(input);
		}
	});

	test('nullable removes the root of either style', () => {
		for (const input of ['[a]\n', '- a\n']) {
			const doc = parse(input);
			doc.nullable = true;
			doc.removeItem([0]);
			expect(doc.toValue()).toBe(null);
			checkTree(doc);
		}
	});
});


describe('refused operations change nothing', () => {
	test('an implicit key out of range', () => {
		const add = parse('{9223372036854775807: a}');
		expectRefused(() => (add.value as InlineArrayNode).addItem('b'), 'Implicit key overflow', add);

		const rename = parse('{5: a, b}');
		expectRefused(() => rename.setKey(['5'], '9223372036854775807'), 'Implicit key overflow', rename);
	});

	test('a donor that already has a parent', () => {
		const target = parse('a # origin\n');
		const donor = parse('b # donor\n');
		expectRefused(() => target.value!.replaceWith(donor.value!), 'parent', target, donor);
		expectRefused(() => target.value = donor.value, 'parent', target, donor);
	});

	test('a node into its own subtree', () => {
		const doc = parse('a:\n\tb: 1\n');
		const block = doc.value as BlockArrayNode;
		expectRefused(() => (block.items[0]!.value as BlockArrayNode).items[0]!.value = block, /parent|own subtree/, doc);
	});

	test('arrays nested deeper than the parser reads', () => {
		const doc = parse('a: ' + '['.repeat(498) + 'x' + ']'.repeat(498));
		const path = ['a', ...Array<number>(497).fill(0)];
		doc.setValue([...path, 0], [1]); // level 500
		expect(parse(doc.print()).toValue()).toEqual(doc.toValue());
		expectRefused(() => doc.setValue([...path, 0], [[1]]), 'Too deep nesting', doc);
		expectRefused(() => doc.findItem([...path, 0])!.value = detached('[[1]]'), 'Too deep nesting', doc);
		expectRefused(() => (doc.findItem(path)!.value as InlineArrayNode).addItem(detached('[[1]]')), 'Too deep nesting', doc);

		const chain = parse('[a()b()]');
		const link = detached('c(' + '['.repeat(499) + '1' + ']'.repeat(499) + ')');
		const links = ((chain.value as InlineArrayNode).items[0]!.value as EntityChainNode).entities;
		expectRefused(() => links[1]!.replaceWith(link), 'Too deep nesting', chain);
	});

	test('a value the encoder refuses', () => {
		const doc = parse('a: 1\nb: [x]\n');
		expectRefused(() => doc.setValue(['a'], Infinity), 'INF', doc);
		expectRefused(() => doc.setValue(['b'], [1, () => 0]), 'cannot be encoded', doc);
		expectRefused(() => doc.addItem(['b'], new Map<unknown, number>([[1, 1], ['1', 2]])), 'twice', doc);
	});
});


describe('removing keeps the comments of others', () => {
	test('a block opened on the line of a dash', () => {
		const dropped = parse('- a: 1\n  # about b\n  b: 2\n');
		dropped.removeItem([0, 'a']);
		expect(dropped.print()).toBe('-\n  # about b\n  b: 2\n');
		checkTree(dropped);

		const moved = parse('- a: 1 # about a\n  b: 2\n');
		moved.removeItem([0, 'a'], { comments: CommentPolicy.MoveToNextToken });
		expect(moved.print()).toBe('-\n  # about a\n  b: 2\n');
		checkTree(moved);

		const plain = parse('- a: 1\n  b: 2\n');
		plain.removeItem([0, 'a']);
		expect(plain.print()).toBe('- b: 2\n');
	});

	test('an inline array', () => {
		for (const [input, path, output] of [
			['[a, b, c]', [1], '[a, c]'],
			['[a, b]', [1], '[a]'],
			['[a, b,]', [1], '[a,]'],
			['[\n\ta,\n\tb\n]', [1], '[\n\ta\n]'],
			['[\n\ta, b\n]', [0], '[\n\tb\n]'],
			['[x, a # c\n, b]', [1], '[x,\nb]'],
		] as const) {
			const doc = parse(input);
			doc.removeItem([...path]);
			expect(doc.print(), input).toBe(output);
			checkTree(doc);
		}
	});
});


describe('inserting into an inline array keeps the comments', () => {
	const take = (source: string): ArrayItemNode => {
		const item = parse(source).findItem(['x'])!;
		item.remove();
		return item;
	};
	const commented = '# belongs to x\nx: 1 # note\n';

	test('the comments of the item become lines above it, or it is refused on one line', () => {
		let doc = parse('{\n\ta: 1, b: 2\n}\n');
		(doc.value as InlineArrayNode).insert(1, take(commented));
		expect(doc.print()).toBe('{\n\ta: 1,\n\t# belongs to x\n\t# note\n\tx: 1,\n\tb: 2\n}\n');
		checkTree(doc);

		doc = parse('{\n\ta: 1\n}\n');
		(doc.value as InlineArrayNode).insert(0, take('x: # after colon\n\t# above the value\n\t1\n'));
		expect(doc.print()).toBe('{\n\t# after colon\n\t# above the value\n\tx: 1,\n\ta: 1\n}\n');

		for (const text of ['{}', '{a: 1}']) {
			const target = parse(text);
			const item = take(commented);
			const restore = snapshot(target, item);
			expect(() => (target.value as InlineArrayNode).insert(0, item)).toThrow('An item with comments cannot stand in an inline array on one line.');
			restore();
		}
		doc = parse('{a: 1}');
		(doc.value as InlineArrayNode).insert(1, take('x: 1\n'));
		expect(doc.print()).toBe('{a: 1, x: 1}');
	});

	test('an item added before another takes only its preamble', () => {
		const doc = parse('[\n\t# header\n\n\t# about b\n\tb\n]');
		(doc.value as InlineArrayNode).addItem('a', { position: 0 });
		expect(doc.print()).toBe('[\n\t# header\n\n\ta,\n\t# about b\n\tb\n]');
		(doc.value as InlineArrayNode).items[0]!.remove();
		expect(doc.print()).toBe('[\n\t# header\n\n\t# about b\n\tb\n]');
	});
});


describe('equal values are a no-op', () => {
	test.each([
		['a: 9007199254740993\n', 9007199254740993n],
		['a: 1\n', 1n],
		['a: 0x10\n', 16],
		['a: 1e999\n', Infinity],
		['a: -0.0\n', 0],
		['a: 2024-02-29\n', new NeonDate(2024, 2, 29)],
		['a: 2024-02-30\n', '2024-02-30'],
		['a: b(1, x: 2)\n', new Entity('b', { 0: 1, x: 2 })],
		['a: {x: 1, y: 2}\n', { y: 2, x: 1 }],
		['a: {x: 1, y: 2}\n', new Map([['x', 1], ['y', 2]])],
		['a: []\n', []],
		['a: {}\n', {}],
	] as const)('%s', (input, value) => {
		const doc = parse(input);
		doc.setValue(['a'], value);
		expect(doc.print()).toBe(input);
	});

	test.each([
		['a: {x: 1, y: 2}\n', new Map([['y', 2], ['x', 1]]), 'a:\n\ty: 2\n\tx: 1\n'],
		['a: []\n', {}, 'a: {}\n'],
		['a: 1\n', 1.5, 'a: 1.5\n'],
	] as const)('%s changes', (input, value, output) => {
		const doc = parse(input);
		doc.setValue(['a'], value);
		expect(doc.print()).toBe(output);
	});
});


describe('construction', () => {
	test('a token and a trivia check their text', () => {
		expect(() => new Token('Colon', 'abc')).toThrow();
		expect(() => new Trivia('Comment', 'abc')).toThrow();
	});

	test('the kind and the origin of a token cannot be written', () => {
		const token = Token.fromText('a');
		expect(() => (token as { kind: string }).kind = 'Colon').toThrow();
		expect(() => (token as { origin: unknown }).origin = null).toThrow();
		expect(token.kind).toBe('Literal');
		const lone = String.fromCharCode(0xD800);
		expect(() => Token.fromText(lone)).toThrow();
		expect(() => token.setText('a' + lone)).toThrow();
	});

	test('trivia setters of an attached token check the place', () => {
		const doc = parse('a: 1\nb: 2\n');
		const key = doc.findItem(['a'])!.key!.token;
		expectRefused(() => key.setTrailingTrivia([Trivia.fromText('# hi')]), 'line ending', doc);
		expectRefused(() => doc.findItem(['b'])!.key!.token.setLeadingTrivia([Trivia.fromText(String.fromCharCode(0xFEFF))]), 'byte order mark', doc);
		expectRefused(() => doc.findItem(['a'])!.value!.getFirstToken().setLeadingTrivia([Trivia.fromText(' ')]), 'same line', doc);
		doc.findItem(['b'])!.value!.getFirstToken().setTrailingTrivia([Trivia.fromText(' '), Trivia.fromText('# two'), Trivia.fromText('\n')]);
		expect(doc.print()).toBe('a: 1\nb: 2 # two\n');
		checkTree(doc);

		const free = Token.fromText('x').setTrailingTrivia([Trivia.fromText('# free')]);
		expect(free.toString()).toBe('x# free');
	});

	test('clone() is deep and detached', () => {
		const doc = parse('a: b(1, [2]) # c\n');
		const copy = doc.clone();
		expect(copy.print()).toBe(doc.print());
		const original = new Set(doc.getTokens());
		expect(copy.getTokens().some((token) => original.has(token))).toBe(false);
		expect(copy.getTokens()[0]!.origin).toEqual(doc.getTokens()[0]!.origin);

		const item = doc.findItem(['a'])!.clone();
		expect(item.parent).toBe(null);
		const target = parse('x: 1\n');
		(target.value as BlockArrayNode).insert(1, item);
		expect(target.print()).toBe('x: 1\na: b(1, [2]) # c\n');
		checkTree(target);

		const inline = parse('x: [k: 1, l: 2]\n');
		(target.value as BlockArrayNode).insert(2, inline.findItem(['x', 'k'])!.clone());
		expect(target.print()).toBe('x: 1\na: b(1, [2]) # c\nk: 1\n');
		checkTree(target);
	});

	test('a built token has no origin', () => {
		const doc = parse('a: 1\nb: 2\n');
		doc.setValue(['a'], 'new');
		doc.setValue(['c'], [1]);
		expect(doc.findItem(['a'])!.value!.getFirstToken().origin).toBe(null);
		expect(doc.findItem(['c'])!.getTokens().every((token) => token.origin === null)).toBe(true);
		expect(doc.findItem(['b'])!.value!.getFirstToken().origin).toMatchObject({ line: 2, column: 4 });
	});
});
