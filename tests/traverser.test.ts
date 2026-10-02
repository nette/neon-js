import { expect, test } from 'vitest';
import { ArrayItemNode, LiteralNode, type Node } from '../src/nodes.ts';
import { parse } from '../src/parser.ts';
import { TraverseAction, Traverser } from '../src/traverser.ts';


const names = (node: Node) => node instanceof LiteralNode ? node.token.text : node.constructor.name;


test('order of enter and leave', () => {
	const document = parse('a: [b, c]\nd: e');
	const log: string[] = [];
	Traverser.traverse(document, (node) => void log.push('> ' + names(node)), (node) => void log.push('< ' + names(node)));
	expect(log).toEqual([
		'> DocumentNode', '> BlockArrayNode',
		'> ArrayItemNode', '> a', '< a', '> InlineArrayNode',
		'> ArrayItemNode', '> b', '< b', '< ArrayItemNode',
		'> ArrayItemNode', '> c', '< c', '< ArrayItemNode',
		'< InlineArrayNode', '< ArrayItemNode',
		'> ArrayItemNode', '> d', '< d', '> e', '< e', '< ArrayItemNode',
		'< BlockArrayNode', '< DocumentNode',
	]);
});


test('a value that is not an action steers nothing', () => {
	const document = parse('a: [b, c]\nd: e');
	let visited = 0;
	Traverser.traverse(document, () => (visited++, 1) as never, () => 2 as never);
	expect(visited).toBe(12);
	expect(document.print()).toBe('a: [b, c]\nd: e');
});


test('skipping children and stopping', () => {
	const document = parse('a: [b, c]\nd: e');
	const log: string[] = [];
	Traverser.traverse(document, (node) => {
		log.push(names(node));
		if (node instanceof ArrayItemNode && node.getKeyValue() === 'a') {
			return TraverseAction.SkipChildren;
		} else if (node instanceof LiteralNode && node.token.text === 'd') {
			return TraverseAction.Stop;
		}
	});
	expect(log).toEqual(['DocumentNode', 'BlockArrayNode', 'ArrayItemNode', 'ArrayItemNode', 'd']);
});


test('removing and replacing', () => {
	const document = parse('debug: yes # on\nlist: [x, y, z]\n');
	Traverser.traverse(document, (node) => {
		if (node instanceof ArrayItemNode && node.getValue() === 'y') {
			return TraverseAction.Remove;
		} else if (node instanceof LiteralNode && node.token.text === 'yes') {
			return parse('no').value!.detach();
		}
	});
	expect(document.print()).toBe('debug: no # on\nlist: [x, z]\n');
	expect(() => Traverser.traverse(document, () => TraverseAction.Remove)).toThrow('Only an item can be removed');
});


test('stopping enters and leaves nothing after', () => {
	const document = parse('a:\n\tb: 1\nc: 2');
	const log: string[] = [];
	Traverser.traverse(
		document,
		(node) => {
			log.push('> ' + names(node));
			return node instanceof LiteralNode && node.token.text === '1' ? TraverseAction.Stop : undefined;
		},
		(node) => void log.push('< ' + names(node)),
	);
	expect(log).toEqual(['> DocumentNode', '> BlockArrayNode', '> ArrayItemNode', '> a', '< a', '> BlockArrayNode', '> ArrayItemNode', '> b', '< b', '> 1']);
});


test('a sibling taken out by the visitor is skipped', () => {
	const document = parse('a: 1\nb: 2\nc: 3\n');
	const log: (string | null)[] = [];
	Traverser.traverse(document, (node) => {
		if (node instanceof ArrayItemNode) {
			log.push(node.getKeyValue());
			if (node.getKeyValue() === 'a') {
				(node.getNextSibling() as ArrayItemNode).remove();
			} else if (node.getKeyValue() === 'b') {
				return TraverseAction.Remove;
			}
		}
	});
	expect(log).toEqual(['a', 'c']);
	expect(document.print()).toBe('a: 1\nc: 3\n');
});


test('a node the visitor takes out itself is neither walked into nor left', () => {
	const document = parse('a: [x, y]\nb: [z]\n');
	const log: string[] = [];
	const res = Traverser.traverse(
		document.value!,
		(node) => {
			log.push('> ' + names(node));
			if (node instanceof ArrayItemNode && node.getKeyValue() === 'a') {
				node.remove();
			}
		},
		(node) => void log.push('< ' + names(node)),
	);
	expect(res).toBe(document.value);
	expect(log).toEqual(['> BlockArrayNode', '> ArrayItemNode', '> ArrayItemNode', '> b', '< b', '> InlineArrayNode', '> ArrayItemNode', '> z', '< z', '< ArrayItemNode', '< InlineArrayNode', '< ArrayItemNode', '< BlockArrayNode']);
	expect(document.print()).toBe('b: [z]\n');
});


test('a node taken out while its children are walked is not left', () => {
	const document = parse('a: [x, y]\nb: 1\n');
	const log: string[] = [];
	Traverser.traverse(
		document,
		(node) => {
			log.push('> ' + names(node));
			if (node instanceof LiteralNode && node.token.text === 'x') {
				node.findAncestor(ArrayItemNode)!.findAncestor(ArrayItemNode)!.remove();
			}
		},
		(node) => void log.push('< ' + names(node)),
	);
	expect(log).toEqual(['> DocumentNode', '> BlockArrayNode', '> ArrayItemNode', '> a', '< a', '> InlineArrayNode', '> ArrayItemNode', '> x', '> ArrayItemNode', '> b', '< b', '> 1', '< 1', '< ArrayItemNode', '< BlockArrayNode', '< DocumentNode']);
	expect(document.print()).toBe('b: 1\n');
});
