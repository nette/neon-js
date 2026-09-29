import { ArrayItemNode, BlockArrayNode, DocumentNode, type Node } from './nodes.ts';
import { iterateNeighbours, type Token } from './token.ts';


/** Layout of new text, derived from the neighbourhood of the place of an edit. */
export class Layout {
	/** The difference of indentation between a nested block and its parent. */
	static unit(at: Node): string {
		for (const candidate of candidates(at)) {
			const unit = unitOf(candidate);
			if (unit) {
				return unit;
			}
		}
		return '\t';
	}


	/**
	 * The indentation of the block the item is in. It is the indentation of the line of the item, except
	 * for the first item of a block opened on the line of a dash, which stands after the dash.
	 */
	static indentation(item: ArrayItemNode): string {
		const block = item.parent;
		const owner = block?.parent;
		if (block instanceof BlockArrayNode && owner instanceof ArrayItemNode && owner.bullet
			&& !owner.bullet.trailingTrivia.some((t) => t.kind === 'LineEnding')
		) {
			const second = block.items[1];
			if (second) {
				return second.getIndentation();
			}
			// as the parser decides: a tab if the next line within the block starts with one
			const outer = Layout.indentation(owner);
			const next = block.getTokens().slice(1).find((token) => token.leadingTrivia.some((t) => t.kind === 'Whitespace')
				&& !!token.leadingTrivia.length);
			const nextIndent = next?.leadingTrivia.at(-1)?.text ?? '';
			return outer + (nextIndent.startsWith(outer + '\t') ? '\t' : '  ');
		}
		return item.getIndentation();
	}


	/** The line ending of the nearest preceding token, else the first of the document, else LF. */
	static lineEnding(at: Node | Token): string {
		const root = rootOf(at);
		if (!root) {
			return '\n';
		}
		const token = at instanceof ArrayItemNode || 'getFirstToken' in at ? (at as Node).getFirstToken() : at as Token;
		const first = root.getFirstToken();
		const find = (list: Iterable<Token>) => {
			for (const token of list) {
				const trivia = [...token.trailingTrivia, ...token.leadingTrivia].find((t) => t.kind === 'LineEnding');
				if (trivia) {
					return trivia.text;
				}
			}
			return null;
		};
		return find(iterateNeighbours(token, true)) ?? find([first]) ?? find(iterateNeighbours(first, false)) ?? '\n';
	}
}


/** The blocks to take the unit from: the siblings, the nearest first, then the ancestors, then the whole document. */
function* candidates(at: Node): Generator<BlockArrayNode> {
	const block = at instanceof BlockArrayNode ? at : at.findAncestor(BlockArrayNode);
	if (block) {
		const item = at instanceof ArrayItemNode ? at : at.findAncestor(ArrayItemNode);
		const index = item ? Math.max(block.items.indexOf(item), 0) : 0;
		for (let distance = 0; distance < block.items.length; distance++) {
			for (const i of distance ? [index - distance, index + distance] : [index]) {
				const value = block.items[i]?.value;
				if (value instanceof BlockArrayNode) {
					yield value;
				}
			}
		}
	}
	for (let node: Node | null = block; node; node = node.parent) {
		if (node instanceof BlockArrayNode) {
			yield node;
		}
	}
	const root = rootOf(at);
	if (root) {
		yield* root.find(BlockArrayNode);
	}
}


/** Unit of a nested block, or null for a block opened on the line of a dash or not nested. */
function unitOf(block: BlockArrayNode): string | null {
	const owner = block.parent;
	if (!(owner instanceof ArrayItemNode)) {
		return null;
	}
	const head = owner.colon ?? owner.bullet;
	if (!head?.trailingTrivia.some((t) => t.kind === 'LineEnding')) {
		return null; // opened on the line of the dash
	}
	const outer = owner.getIndentation();
	const inner = block.items[0]!.getIndentation();
	return inner.length > outer.length && inner.startsWith(outer) ? inner.slice(outer.length) : null;
}


function rootOf(at: Node | Token): DocumentNode | null {
	let node = at.parent;
	if (at instanceof DocumentNode) {
		return at;
	}
	while (node?.parent) {
		node = node.parent;
	}
	return node instanceof DocumentNode ? node : null;
}
