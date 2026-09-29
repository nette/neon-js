import { expect } from 'vitest';
import { dump } from '../src/dumper.ts';
import { type DocumentNode, Node } from '../src/nodes.ts';
import { parse } from '../src/parser.ts';
import type { Token } from '../src/token.ts';


/** The guarantees of editing that hold for any tree. */
export function checkTree(document: DocumentNode): void {
	const seen = (new Set<Node | Token>);
	const walk = (node: Node) => {
		for (const child of node.getChildren()) {
			expect(child.parent, 'parents agree with the walk').toBe(node);
			expect(seen.has(child), 'no node or token stands twice').toBe(false);
			seen.add(child);
			if (child instanceof Node) {
				walk(child);
			}
		}
	};
	walk(document);
	checkCanonical(document);
	expect(dump(parse(document.print())), 'the printed tree parses to the same tree').toBe(dump(document));
}


/** The trivia of the document are in the canonical form, checked by the rules, not by a reparse. */
export function checkCanonical(document: DocumentNode): void {
	const tokens = document.getTokens();
	tokens.forEach((token, i) => {
		const prev = tokens[i - 1];
		const lineEnds = token.trailingTrivia.filter((t) => t.kind === 'LineEnding');
		expect(lineEnds.length <= 1 && (!lineEnds.length || token.trailingTrivia.at(-1)!.kind === 'LineEnding'), 'one line ending, last of the trailing trivia').toBe(true);
		if (prev && !prev.trailingTrivia.some((t) => t.kind === 'LineEnding')) {
			expect(token.leadingTrivia, 'no leading trivia on the line of the token before').toEqual([]);
		}
		for (const list of [token.leadingTrivia, token.trailingTrivia]) {
			expect(new Set(list).size, 'an instance stands in a list once').toBe(list.length);
			list.forEach((t, k) => {
				expect(t.kind === 'Whitespace' && list[k + 1]?.kind === 'Whitespace', 'no two whitespace trivia side by side').toBe(false);
				expect(t.text.endsWith('\r') && (list[k + 1]?.text.startsWith('\n') ?? false), 'no carriage return before a line feed of the next trivia').toBe(false);
				if (t.kind === 'ByteOrderMark') {
					expect(i === 0 && list === token.leadingTrivia && k === 0, 'a byte order mark only at the start').toBe(true);
				} else if (t.kind === 'Comment' && list[k + 1]?.kind !== 'LineEnding') {
					expect(token.kind === 'EndOfFile' || tokens[i + 1]?.kind === 'EndOfFile', 'a comment ends its line, but at the end of the input').toBe(true);
				}
			});
		}
	});
	expect(document.endOfFile.trailingTrivia).toEqual([]);
}


/** The state of everything reachable from the nodes: identities, parents, children, flags, texts and trivia. */
export function snapshot(...nodes: Node[]): () => void {
	const tokens = nodes.flatMap((node) => node.getTokens());
	const state = tokens.map((token) => [token, token.parent, token.text, token.leadingTrivia, token.trailingTrivia] as const);
	const capture = (node: Node) => [node.parent, ...node.getChildren(), 'nullable' in node ? node.nullable : null];
	const nodeState: [Node, unknown[]][] = [];
	const walk = (node: Node) => {
		nodeState.push([node, capture(node)]);
		for (const child of node.getChildren()) {
			if (child instanceof Node) {
				walk(child);
			}
		}
	};
	nodes.forEach(walk);
	const texts = nodes.map((node) => node.print());

	return () => {
		expect(nodes.map((node) => node.print()), 'a refused operation leaves the text').toEqual(texts);
		const now = nodes.flatMap((node) => node.getTokens());
		expect(now.length === tokens.length && now.every((token, i) => token === tokens[i]), 'and the tokens').toBe(true);
		for (const [token, parent, text, leading, trailing] of state) {
			expect(token.parent === parent && token.text === text && token.leadingTrivia === leading && token.trailingTrivia === trailing, 'and every token as it was').toBe(true);
		}
		for (const [node, captured] of nodeState) {
			const now = capture(node);
			expect(now.length === captured.length && now.every((x, i) => x === captured[i]), 'and every node with its parent, children and flags').toBe(true);
		}
	};
}
