import { Node } from './nodes.ts';
import type { Token, Trivia } from './token.ts';


/** Text form of the tree, as in the conformance corpus. */
export function dump(node: Node): string {
	const lines: string[] = [];
	const write = (node: Node, prefix: string, depth: number) => {
		const indent = '\t'.repeat(depth);
		lines.push(indent + prefix + node.constructor.name);
		for (const [slot, value] of slots(node)) {
			if (value === null) {
				continue;
			} else if (Array.isArray(value)) {
				if (!value.length) {
					lines.push(`${indent}\t${slot}: []`);
					continue;
				}
				lines.push(`${indent}\t${slot}:`);
				for (const item of value) {
					write(item, '- ', depth + 2);
				}
			} else if (value instanceof Node) {
				write(value, slot + ': ', depth + 1);
			} else {
				lines.push(`${indent}\t${slot}: ${dumpToken(value)}`);
			}
		}
	};
	write(node, '', 0);
	return lines.join('\n') + '\n';
}


function slots(node: Node): [string, Node | Token | Node[] | null][] {
	const n = node as unknown as Record<string, Node | Token | readonly Node[] | null>;
	return (SlotNames[node.constructor.name] ?? []).map((name) => {
		const value = n[name]!;
		return [name, Array.isArray(value) ? [...value] : value as Node | Token | null];
	});
}


const SlotNames: Record<string, string[]> = {
	DocumentNode: ['value', 'endOfFile'],
	BlockArrayNode: ['items'],
	InlineArrayNode: ['openBracket', 'items', 'closeBracket'],
	ArrayItemNode: ['bullet', 'key', 'colon', 'value', 'separator'],
	EntityNode: ['value', 'attributes'],
	EntityChainNode: ['entities'],
	StringNode: ['token'],
	LiteralNode: ['token'],
};


export function dumpToken(token: Token): string {
	let res = `${token.kind} ${dumpText(token.text)}`;
	if (token.leadingTrivia.length) {
		res += ' <' + dumpTrivia(token.leadingTrivia);
	}
	if (token.trailingTrivia.length) {
		res += ' >' + dumpTrivia(token.trailingTrivia);
	}
	return res;
}


function dumpTrivia(list: readonly Trivia[]): string {
	return '[' + list.map((trivia) => `${trivia.kind} ${dumpText(trivia.text)}`).join(', ') + ']';
}


/** JSON string escaping only quotes, backslashes and control characters. */
function dumpText(text: string): string {
	let res = '"';
	for (const c of text) {
		const code = c.charCodeAt(0);
		res += ShortEscapes[c]
			?? (c === '"' || c === '\\' ? '\\' + c : code < 0x20 ? '\\u' + code.toString(16).padStart(4, '0') : c);
	}
	return res + '"';
}


const ShortEscapes: Record<string, string> = {
	'\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t',
};
