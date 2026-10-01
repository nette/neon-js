import { describe, expect, test } from 'vitest';
import { dump } from '../src/dumper.ts';
import { CommentPolicy, type PathSegment } from '../src/editing.ts';
import { NeonError } from '../src/errors.ts';
import { type ArrayItemNode, type ArrayNode, type BlockArrayNode, type DocumentNode, type InlineArrayNode, LiteralNode, StringNode } from '../src/nodes.ts';
import { parse } from '../src/parser.ts';
import { Entity, type NeonValue } from '../src/values.ts';
import { loadCases, runsHere } from './corpus.ts';
import { checkTree, snapshot } from './guarantees.ts';
import { equal, toEncodable, toHost, type Typed } from './typed.ts';


interface Operation {
	op: 'set' | 'add' | 'remove' | 'setKey';
	path: PathSegment[];
	value?: Typed;
	key?: string;
	position?: number;
	create?: boolean;
	comments?: 'drop' | 'move';
	nullable?: boolean;
	mergeBlankLines?: boolean;
	expectError?: string;
}


const OperationFields: Record<string, string[]> = {
	set: ['value', 'create'],
	add: ['value', 'key', 'position'],
	remove: ['comments', 'nullable', 'mergeBlankLines'],
	setKey: ['key'],
};


/** Applies the operation; returns the item an `add` created. */
function apply(document: DocumentNode, op: Operation): ArrayItemNode | null {
	const known = OperationFields[op.op];
	const unknown = Object.keys(op).filter((field) => !['op', 'path', 'expectError', ...known ?? []].includes(field));
	if (!known || unknown.length || !Array.isArray(op.path) || (op.comments !== undefined && !['drop', 'move'].includes(op.comments))) {
		throw new Error(`Invalid operation ${JSON.stringify(op)}`);
	}
	const value = op.value ? toEncodable(op.value) : undefined;
	const comments = op.comments === 'move' ? CommentPolicy.MoveToNextToken : CommentPolicy.Drop;
	switch (op.op) {
		case 'set':
			document.setValue(op.path, value ?? null, { create: op.create ?? true });
			break;
		case 'add':
			return document.addItem(op.path, value ?? null, { key: op.key, position: op.position });
		case 'remove':
			document.removeItem(op.path, { comments, nullable: op.nullable, mergeBlankLines: op.mergeBlankLines });
			break;
		case 'setKey':
			document.setKey(op.path, op.key!);
			break;
		default:
			throw new Error(`Unknown op ${(op as { op: string }).op}`);
	}
	return null;
}


/**
 * The lines an item spans, with the comment lines it owns above it, 0-based. The locality of an edit
 * is checked only in arrays whose keys are all written or all implicit, where no repair of the grammar
 * (keys written out, a null added) can happen.
 */
function itemLines(item: ArrayItemNode): { start: number; end: number } | null {
	const items = (item.parent as ArrayNode).items;
	if (!items.every((other) => !!other.key) && !items.every((other) => !other.key)) {
		return null;
	}
	const first = item.getFirstToken();
	let owned = 0;
	const lines = first.leadingTrivia.map((t) => t.kind).join(' ').split('LineEnding').slice(0, -1).reverse();
	while (lines[owned]?.includes('Comment')) {
		owned++;
	}
	const last = item.getLastToken();
	return {
		start: first.getPosition()!.line - 1 - owned,
		end: last.getPosition()!.line - 1 + (last.text.match(/\n/g)?.length ?? 0),
	};
}


/** Only the lines of the item and one line on each side of it differ between the two texts. */
function checkLocality(withItem: string, without: string, lines: { start: number; end: number }, label: string): void {
	const a = withItem.split('\n');
	const b = without.split('\n');
	const head = Math.max(0, lines.start - 1);
	const tail = Math.max(0, a.length - lines.end - 2);
	expect(b.slice(0, head), label + ': the lines before').toEqual(a.slice(0, head));
	expect(tail ? b.slice(-tail) : [], label + ': the lines after').toEqual(tail ? a.slice(-tail) : []);
}


// ---- an independent model of the value: plain values edited directly


type Model = NeonValue;

function container(model: Model, path: PathSegment[]): Model {
	let node = model;
	for (const segment of path) {
		node = child(node, segment);
	}
	return node instanceof Entity ? node.attributes : node;
}

function child(node: Model, segment: PathSegment): Model {
	const target = node instanceof Entity ? node.attributes : node;
	return (target as Record<string, Model>)[typeof segment === 'object' ? segment.item : segment]!;
}

function setIn(parent: Model, key: PathSegment, value: Model): Model {
	if (Array.isArray(parent)) {
		parent[Number(key)] = value;
	} else {
		(parent as Record<string, Model>)[String(key)] = value;
	}
	return parent;
}

function applyToModel(model: Model, op: Operation): Model {
	const value = op.value ? toEncodable(op.value) as Model : null;
	const plain = mapsToObjects(value) as Model;
	if (op.op === 'set') {
		if (!op.path.length) {
			return plain;
		}
		const parent = container(model, op.path.slice(0, -1));
		if (parent === null) {
			const owner = container(model, op.path.slice(0, -2));
			setIn(owner, op.path.at(-2)!, { [String(op.path.at(-1))]: plain });
		} else {
			setIn(parent, op.path.at(-1)!, plain);
		}
	} else if (op.op === 'add') {
		const parent = container(model, op.path);
		if (Array.isArray(parent) && op.key === undefined) {
			parent.splice(op.position ?? parent.length, 0, plain);
		} else {
			const entries = Object.entries(parent as object);
			entries.splice(op.position ?? entries.length, 0, [op.key!, plain]);
			replaceContents(parent as Record<string, Model>, Object.fromEntries(entries));
		}
	} else if (op.op === 'remove') {
		const parent = container(model, op.path.slice(0, -1));
		const key = op.path.at(-1)!;
		if (Array.isArray(parent)) {
			parent.splice(Number(key), 1);
		} else {
			delete (parent as Record<string, Model>)[String(key)];
		}
		const empty = Array.isArray(parent) ? !parent.length : !Object.keys(parent as object).length;
		if (empty && op.nullable && op.path.length > 1) {
			setIn(container(model, op.path.slice(0, -2)), op.path.at(-2)!, null);
		} else if (empty && op.nullable) {
			return null;
		}
	} else if (op.op === 'setKey') {
		const parent = container(model, op.path.slice(0, -1)) as Record<string, Model>;
		const entries = Object.entries(parent).map(([k, v]): [string, Model] => [k === String(op.path.at(-1)) ? op.key! : k, v]);
		replaceContents(parent, Object.fromEntries(entries));
	}
	return model;
}

function replaceContents(target: Record<string, Model>, source: Record<string, Model>): void {
	for (const key of Object.keys(target)) {
		delete target[key];
	}
	Object.assign(target, source);
}

function mapsToObjects(value: unknown): unknown {
	if (value instanceof Map) {
		return Object.fromEntries([...value].map(([k, v]) => [k, mapsToObjects(v)]));
	} else if (Array.isArray(value)) {
		return value.map(mapsToObjects);
	}
	return value;
}


describe('corpus mutations', () => {
	test.each(loadCases('mutations').filter(runsHere).map((c) => [c.name, c]))('%s', (_, c) => {
		const input = c.read('.neon')!;
		const ops = JSON.parse(c.read('.ops.json')!) as Operation[];
		const document = parse(input);
		let model = document.toValue();
		const expectedValue = c.read('.expected.json'); // written down where a repair of the grammar makes the value differ from a plain edit

		ops.forEach((op, n) => {
			const before = document.print();
			const lexeme = op.op === 'set' ? scalarLexeme(document, op.path) : null;
			const removed = op.op === 'remove' && !op.expectError ? document.findItem(op.path) : null;
			const removedLines = removed && itemLines(removed);
			if (op.expectError) {
				const unchanged = snapshot(document);
				expect(() => apply(document, op)).toThrow(op.expectError);
				unchanged();
			} else {
				const added = apply(document, op);
				model = applyToModel(model, op);
				const addedLines = added && itemLines(added);
				if (addedLines) {
					checkLocality(document.print(), before, addedLines, `locality of operation ${n + 1}`);
				}
			}
			if (removedLines) {
				checkLocality(before, document.print(), removedLines, `locality of operation ${n + 1}`);
			}
			checkTree(document);

			const stepValue = n === ops.length - 1 ? expectedValue : c.read(`.expected.${n + 1}.json`);
			if (expectedValue !== null && ops.length > 1 && n < ops.length - 1 && stepValue === null) {
				throw new Error(`A case with .expected.json writes down the value after each operation: missing .expected.${n + 1}.json`);
			}
			const value = parse(document.print()).toValue();
			expect(equal(value, stepValue !== null ? toHost(JSON.parse(stepValue) as Typed) : model), `the value after operation ${n + 1}`).toBe(true);

			if (lexeme && op.value && !['list', 'map', 'null'].includes(op.value.type)) { // locality of a scalar change
				const after = document.print();
				expect(after.slice(0, lexeme.start)).toBe(before.slice(0, lexeme.start));
				expect(after.slice(after.length - (before.length - lexeme.end))).toBe(before.slice(lexeme.end));
			}
			const step = c.read(`.expected.${n + 1}.neon`);
			if (step !== null) {
				expect(document.print()).toBe(step);
			}
		});

		expect(document.print()).toBe(c.read('.expected.neon'));
		if (expectedValue !== null) {
			expect(equal(document.toValue(), toHost(JSON.parse(expectedValue) as Typed)), 'the value of the tree').toBe(true);
		}
	});
});


/** Where the token of a scalar at the path stands in the printed text. */
function scalarLexeme(document: DocumentNode, path: PathSegment[]): { start: number; end: number } | null {
	const node = document.findItem(path)?.value;
	if (!(node instanceof LiteralNode || node instanceof StringNode)) {
		return null;
	}
	const start = node.token.getPosition()!.utf16Offset;
	return { start, end: start + node.token.text.length };
}


test('a refused operation leaves the tree as it was', () => {
	const document = parse('a: {x: 1}\nb: [1]\n');
	const before = dump(document);
	expect(() => document.findItem(['a', 'x'])!.setValue(parse('- x\n- y').value!.detach())).toThrow('block cannot stand');
	expect(() => document.findItem(['a', 'x'])!.setValue(document.findItem(['b'])!.value)).toThrow('already has a parent');
	expect(() => document.setValue(['a', 'x', 'y'], 1)).toThrow(NeonError);
	expect(() => document.addItem(['b'], 2, { position: 5 })).toThrow(RangeError);
	expect(() => document.setValue(['a'], undefined)).toThrow('undefined cannot be encoded');
	expect(dump(document)).toBe(before);
});


test('replaceWith() and detach()', () => {
	const document = parse('a: 1 # one\nb: [x]\n');
	const one = document.findItem(['a'])!.value!;
	one.replaceWith(parse('2').value!.detach());
	expect(document.print()).toBe('a: 2 # one\nb: [x]\n');
	expect(one.parent).toBeNull();

	const list = document.findItem(['b'])!.value!.detach();
	expect(document.print()).toBe('a: 2 # one\nb:\n');
	expect(list.print()).toBe('[x]\n'); // with the trivia at its edges
});


test('an item moves to another indentation with its comments and multiline strings', () => {
	const input = [
		'a:',
		'\tkeep: 1',
		'\t# about db',
		'\tdb:',
		'\t\thost: x',
		'\t\tnote: \'\'\'',
		'\t\t\tfirst',
		'\t\t\t  second',
		'\t\t\'\'\'',
		'b:',
		'    x: 1',
		'',
	].join('\n');
	const document = parse(input);
	const db = document.findItem(['a', 'db'])!;
	db.remove();
	const target = document.findItem(['b'])!.value as BlockArrayNode;
	target.insert(1, db);
	expect(document.print()).toBe([
		'a:',
		'\tkeep: 1',
		'b:',
		'    x: 1',
		'    # about db',
		'    db:',
		'    \thost: x',
		'    \tnote: \'\'\'',
		'\t\t\tfirst',
		'\t\t\t  second',
		'\t\t\'\'\'',
		'',
	].join('\n'));
	checkTree(document);
	expect(document.toValue()).toEqual({ a: { keep: 1 }, b: { x: 1, db: { host: 'x', note: 'first\n  second' } } });
	expect(() => target.insert(0, document.findItem(['a', 'keep'])!)).toThrow('already has a parent');

	const inline = parse('a: [x, y]\nb: [z]\n');
	const y = inline.findItem(['a', 1])!;
	y.remove();
	(inline.findItem(['b'])!.value as InlineArrayNode).insert(0, y);
	expect(inline.print()).toBe('a: [x]\nb: [y, z]\n');
});
