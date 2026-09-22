import type { Node } from './nodes.ts';
import { Cursor } from './position.ts';
import type { Position, Token } from './token.ts';


/** The source text of the node, with the trivia of its tokens. */
export function print(node: Node): string {
	return node.print();
}


/** The text of the node without the leading trivia of its first token and the trailing trivia of its last. */
export function printText(node: Node): string {
	const tokens = node.getTokens();
	let res = '';
	tokens.forEach((token, i) => {
		if (i > 0) {
			res += triviaText(token.leadingTrivia);
		}
		res += token.text;
		if (i < tokens.length - 1) {
			res += triviaText(token.trailingTrivia);
		}
	});
	return res;
}


/** Current positions of all tokens of the tree in one walk, for an editor asking about many of them. */
export function locateAll(root: Node): Map<Token, Position> {
	const tokens = root.getTokens();
	const offsets: number[] = [];
	let text = '';
	for (const token of tokens) {
		text += triviaText(token.leadingTrivia);
		offsets.push(text.length);
		text += token.text + triviaText(token.trailingTrivia);
	}

	const cursor = new Cursor(text);
	return new Map(tokens.map((token, i) => [token, cursor.at(offsets[i]!)]));
}


function triviaText(trivia: readonly { text: string }[]): string {
	let res = '';
	for (const t of trivia) {
		res += t.text;
	}
	return res;
}
