import { expect, test } from 'vitest';
import { CommentPolicy, type PathSegment } from '../src/editing.ts';
import {
	ArrayItemNode,
	ArrayNode,
	BlockArrayNode,
	type DocumentNode,
	EntityChainNode,
	EntityNode,
	InlineArrayNode,
	itemKeys,
	type Node,
	type ValueNode,
} from '../src/nodes.ts';
import { parse } from '../src/parser.ts';
import { Chain, Entity, NeonDate, valuesEqual } from '../src/values.ts';
import { loadCases } from './corpus.ts';
import { checkTree, snapshot } from './guarantees.ts';


// Random sequences of edits over the documents of the corpus. After each edit the tree must stay valid
// and its value must be what the same edit does to an independent model; an edit the library refuses
// must change nothing, neither in the document nor in a donor of a node.


// ---- an ordered model: a list is an array, a map is a Map in the order of the document

class EntityModel {
	constructor(readonly value: Model, readonly attributes: Model) {
	}
}

type Model = unknown;


/** A Map with the keys 0..n-1 in order is a list. */
function normalize(entries: Map<string, Model>): Model {
	return entries.size && [...entries.keys()].every((key, i) => key === String(i)) ? [...entries.values()] : entries;
}


function fromNode(node: ValueNode | null): Model {
	if (node === null) {
		return null;
	} else if (node instanceof ArrayNode) {
		const keys = itemKeys(node.items);
		const entries = (new Map<string, Model>);
		node.items.forEach((item, i) => entries.set(keys[i]!, fromNode(item.value))); // an overwritten key keeps its first position
		return entries.size || !Array.isArray(node.toValue()) ? normalize(entries) : [];
	} else if (node instanceof EntityChainNode) {
		return new EntityModel(Chain, node.entities.map(fromNode));
	} else if (node instanceof EntityNode) {
		return new EntityModel(fromNode(node.value), node.attributes ? fromNode(node.attributes) : []);
	}
	return node.toValue();
}


function fromHost(value: unknown): Model {
	if (Array.isArray(value)) {
		return value.map(fromHost);
	} else if (value instanceof Map) {
		return normalize(new Map([...value].map(([k, v]) => [String(k), fromHost(v)])));
	} else if (value instanceof Entity) {
		return new EntityModel(fromHost(value.value), fromHost(value.attributes));
	} else if (value && typeof value === 'object' && !(value instanceof NeonDate)) {
		return normalize(new Map(Object.entries(value).map(([k, v]) => [k, fromHost(v)])));
	}
	return value;
}


function same(a: Model, b: Model): boolean {
	if (Array.isArray(a) || Array.isArray(b)) {
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
	} else if (a instanceof Map || b instanceof Map) {
		const x = a instanceof Map ? [...a] : null;
		const y = b instanceof Map ? [...b] : null;
		return !!x && !!y && x.length === y.length && x.every(([k, v], i) => y[i]![0] === k && same(v, y[i]![1]));
	} else if (a instanceof EntityModel || b instanceof EntityModel) {
		return a instanceof EntityModel && b instanceof EntityModel && same(a.value, b.value) && same(a.attributes, b.attributes);
	}
	return valuesEqual(a, b);
}


/** The array of the model at the path: a list, a map or the attributes of an entity. */
function containerAt(model: Model, path: readonly PathSegment[]): Model {
	let node = model;
	for (const segment of path) {
		node = get(arrayOfModel(node), segment);
	}
	return arrayOfModel(node);
}


function arrayOfModel(node: Model): Model {
	return node instanceof EntityModel ? node.attributes : node;
}


function get(array: Model, key: PathSegment): Model {
	return Array.isArray(array) ? array[Number(key)] : (array as Map<string, Model>).get(String(key));
}


/** Replaces the array at the path by a new one, with the edit applied. */
function update(model: Model, path: readonly PathSegment[], edit: (entries: Map<string, Model>) => Model): Model {
	const write = (node: Model, rest: readonly PathSegment[]): Model => {
		const array = arrayOfModel(node);
		const entries = Array.isArray(array) ? new Map(array.map((v, i) => [String(i), v])) : new Map(array as Map<string, Model>);
		const res = rest.length
			? normalize(new Map([...entries].map(([k, v]) => [k, k === String(rest[0]) ? write(v, rest.slice(1)) : v])))
			: edit(entries);
		return node instanceof EntityModel ? new EntityModel(node.value, res) : res;
	};
	return write(model, path);
}


// ---- the run

const Values: unknown[] = [null, true, 0, 42, -1.5, 'x', 'two words', 'a: b', '-.5', 'line\nbreak', [], {}, [1, 2], { k: 'v' },
	new Map<string, unknown>([['a', 1], ['b', [true]]]), new Entity('E', [1]), new NeonDate(2024, 2, 29)];
const Keys = ['new', 'k', 'two words', '5', 'x:y'];
const DonorTexts = ['scalar', '[1, 2]', '{a: 1}', 'x: 1\ny: [2]\n', '- p\n- q\n', 'E(a: 1)', 'a()b()', '\'quoted\''];


function random(seed: number): () => number {
	return () => {
		seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF;
		return seed / 0x80000000;
	};
}


/** Paths of all items the decoded value can reach, with the items. */
function itemPaths(document: DocumentNode): { path: PathSegment[]; item: ArrayItemNode }[] {
	const res: { path: PathSegment[]; item: ArrayItemNode }[] = [];
	const walk = (node: Node | null, path: PathSegment[]) => {
		const array = node instanceof EntityNode ? node.attributes : node;
		if (!(array instanceof ArrayNode)) {
			return;
		}
		const keys = itemKeys(array.items);
		array.items.forEach((item, i) => {
			if (array.findItem(keys[i]!) === item) {
				const itemPath = [...path, keys[i]!];
				res.push({ path: itemPath, item });
				walk(item.value, itemPath);
			}
		});
	};
	walk(document.value, []);
	return res;
}


function isInside(node: Node, ancestor: Node): boolean {
	for (let n: Node | null = node; n; n = n.parent) {
		if (n === ancestor) {
			return true;
		}
	}
	return false;
}


/** An item with comments may be refused on one line, after it was already taken out. */
function hasComment(item: ArrayItemNode): boolean {
	return item.getTokens().some((token) => [...token.leadingTrivia, ...token.trailingTrivia].some((t) => t.kind === 'Comment'));
}


test('random edits keep the tree valid and the value right, refused ones change nothing', () => {
	const inputs = [...loadCases('roundtrip'), ...loadCases('decode'), ...loadCases('mutations'), ...loadCases('cst')]
		.map((c) => c.read('.neon')!)
		.filter((input) => {
			try {
				parse(input).toValue();
				return true;
			} catch {
				return false;
			}
		});
	inputs.push('', '# only a comment\n', String.fromCharCode(0xFEFF), '42\n');

	const count = { attempts: 0, applied: 0, noops: 0, refused: 0, skipped: 0 };
	const first = Number(process.env.FUZZ_SEED ?? 1);
	for (let seed = first; seed <= (process.env.FUZZ_SEED ? first : Number(process.env.FUZZ_SEEDS ?? 1500)); seed++) {
		const next = random(seed);
		const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
		const document = parse(pick(inputs));
		let model = fromNode(document.value);

		for (let step = 0; step < 4; step++) {
			count.attempts++;
			const paths = itemPaths(document);
			const kind = paths.length ? Math.floor(next() * 9) : 5;
			const { path, item } = paths.length ? pick(paths) : { path: [], item: null };
			const parentPath = path.slice(0, -1);
			const parent = paths.length ? containerAt(model, parentPath) : null;
			const before = document.print();
			const description = `seed ${seed}, step ${step}: ${['set', 'add', 'remove', 'setKey', 'move', 'root', 'node', 'key node', 'refused'][kind]} ${JSON.stringify(path)} in\n${before}`;
			let donor: DocumentNode | null = null;
			let donorNode: Node | null = null;
			let expectRefusal: RegExp | null = null;
			let operation: () => void;
			let after: () => Model;

			if (kind === 0) { // a value of the host
				const value = pick(Values);
				operation = () => document.setValue(path, value);
				after = () => update(model, parentPath, (entries) => normalize(entries.set(String(path.at(-1)), fromHost(value))));

			} else if (kind === 1) { // a new item
				const value = pick(Values);
				const array = item!.parent as ArrayNode;
				if (Array.isArray(parent) && next() < 0.5) {
					operation = () => array.addItem(value);
					after = () => update(model, parentPath, (entries) => normalize(entries.set(String(entries.size), fromHost(value))));
				} else {
					const key = pick(Keys);
					if (Array.isArray(parent) || (parent as Map<string, Model>).has(key)) {
						expectRefusal = /Duplicated key/;
						operation = () => array.addItem(value, { key: Array.isArray(parent) ? '0' : key });
						after = () => model;
					} else {
						operation = () => document.setValue([...parentPath, key], value);
						after = () => update(model, parentPath, (entries) => normalize(entries.set(key, fromHost(value))));
					}
				}

			} else if (kind === 2) { // removing
				const array = item!.parent as ArrayNode;
				if (Array.isArray(parent) && array.items.some((sibling) => sibling.key)) {
					count.skipped++; // keys written in a list stay, so the model cannot just renumber
					continue;
				}
				const comments = next() < 0.5 ? CommentPolicy.Drop : CommentPolicy.MoveToNextToken;
				const emptied = array.items.every((other) => other === item || itemKeys(array.items)[array.items.indexOf(other)] === String(path.at(-1)));
				const empty = array instanceof InlineArrayNode ? (array.openBracket.kind === 'OpenBrace' ? (new Map) : []) : item!.key ? (new Map) : [];
				operation = () => document.removeItem(path, { comments });
				after = () => update(model, parentPath, (entries) => {
					if (emptied) {
						return empty;
					}
					entries.delete(String(path.at(-1)));
					return Array.isArray(parent) ? [...entries.values()] : normalize(entries);
				});

			} else if (kind === 3) { // renaming
				const key = pick(Keys);
				if (!item!.key || Array.isArray(parent)) {
					count.skipped++;
					continue;
				} else if ((parent as Map<string, Model>).has(key) && key !== String(path.at(-1))) {
					expectRefusal = /Duplicated key/;
					after = () => model;
				} else {
					after = () => update(model, parentPath, (entries) => normalize(new Map([...entries].map(([k, v]) => [k === String(path.at(-1)) ? key : k, v]))));
				}
				operation = () => document.setKey(path, key);

			} else if (kind === 4) { // a keyed item moves into another map
				const target = pick(paths);
				const targetArray = target.item.value instanceof EntityNode ? target.item.value.attributes : target.item.value;
				const key = item!.getKeyValue();
				const targetModel = containerAt(model, target.path);
				if (!key || Array.isArray(parent) || !(targetArray instanceof ArrayNode) || isInside(target.item, item!)
					|| !(targetModel instanceof Map) || targetModel.has(key) || (item!.parent as ArrayNode).items.length === 1
					|| (targetArray instanceof InlineArrayNode && hasComment(item!))
				) {
					count.skipped++;
					continue;
				}
				const position = Math.floor(next() * (targetArray.items.length + 1));
				if (targetArray instanceof InlineArrayNode && (item!.bullet || item!.value instanceof BlockArrayNode)) {
					expectRefusal = /cannot stand/;
					const copy = item!.clone();
					operation = () => targetArray.insert(position, copy);
					after = () => model;
				} else {
					const value = get(parent, key);
					operation = () => {
						item!.remove();
						targetArray.insert(position, item!);
					};
					after = () => {
						const removed = update(model, parentPath, (entries) => {
							entries.delete(key);
							return normalize(entries);
						});
						return update(removed, target.path, (entries) => {
							const list = [...entries];
							list.splice(position, 0, [key, value]);
							return normalize(new Map(list));
						});
					};
				}

			} else if (kind === 5) { // the root
				const value = pick(Values);
				operation = () => document.setValue([], value);
				after = () => fromHost(value);

			} else if (kind === 6) { // a node from another document into the value slot
				donor = parse(pick(DonorTexts));
				const inline = item!.parent instanceof InlineArrayNode || (!item!.key && !item!.bullet);
				if (next() < 0.3) {
					const node = donor.value!;
					expectRefusal = /parent|block/; // not detached first
					operation = () => item!.value = node;
					after = () => model;
				} else {
					const value = fromNode(donor.value);
					const node = donor.value!.detach();
					donorNode = node;
					if (node instanceof BlockArrayNode && inline) {
						expectRefusal = /block/i;
						operation = () => item!.value = node;
						after = () => model;
					} else {
						operation = () => item!.setValue(node);
						after = () => update(model, parentPath, (entries) => normalize(entries.set(String(path.at(-1)), value)));
					}
				}

			} else if (kind === 7) { // a key node
				const key = pick(['new', 'k', 'zz']);
				if (!item!.key || Array.isArray(parent)) {
					count.skipped++;
					continue;
				} else if (next() < 0.3) {
					expectRefusal = /cannot be empty/;
					operation = () => item!.key!.detach();
					after = () => model;
				} else if ((parent as Map<string, Model>).has(key) && key !== String(path.at(-1))) {
					expectRefusal = /Duplicated key/;
					operation = () => item!.key!.replaceWith(parse(key).value!.detach());
					after = () => model;
				} else {
					operation = () => item!.key!.replaceWith(parse(key).value!.detach());
					after = () => update(model, parentPath, (entries) => normalize(new Map([...entries].map(([k, v]) => [k === String(path.at(-1)) ? key : k, v]))));
				}

			} else { // operations refused by their shape
				const array = item!.parent as ArrayNode;
				const node = parse('x: 1\n').value!.detach();
				if (array instanceof InlineArrayNode) {
					expectRefusal = /block/i;
					operation = () => array.addItem(node);
				} else {
					expectRefusal = /out of the array/;
					operation = () => array.addItem(1, { position: array.items.length + 1 });
				}
				after = () => model;
			}

			const unchanged = snapshot(document, ...donor ? [donor] : [], ...donorNode ? [donorNode] : []);
			try {
				operation();
				if (expectRefusal) {
					throw new Error('expected a refusal ' + String(expectRefusal));
				}
			} catch (e) {
				if (!expectRefusal || !expectRefusal.test(String(e))) {
					throw new Error(description + '\n' + String(e), { cause: e });
				}
				try {
					unchanged();
				} catch (failure) {
					throw new Error(description + '\nthe refused operation changed something\n' + String(failure), { cause: failure });
				}
				count.refused++;
			}
			model = after();
			if (!expectRefusal) {
				count[document.print() === before ? 'noops' : 'applied']++;
			}
			if (process.env.FUZZ_SEED) {
				console.log(description, '\n=>\n' + document.print());
			}
			try {
				checkTree(document);
				if (donor) {
					checkTree(donor);
				}
			} catch (e) {
				throw new Error(description + '\n' + String(e) + '\nafter:\n' + document.print(), { cause: e });
			}
			expect(same(fromNode(parse(document.print()).value), model), description + '\nafter:\n' + document.print()).toBe(true);
		}
	}
	if (process.env.FUZZ_SEEDS) {
		console.log(count);
	}
	expect(count.applied).toBeGreaterThan(count.attempts / 2);
	expect(count.refused).toBeGreaterThan(count.attempts / 20);
}, 600_000);
