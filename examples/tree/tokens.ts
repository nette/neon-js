/**
 * Tokens and trivia: every character of the file is in a token or in the trivia around it,
 * and a line ends in the trailing trivia of the last token on it.
 *
 * Usage: npx tsx examples/tree/tokens.ts
 */

import { dump, parse, tokenize } from '../../src/index.ts';

for (const token of tokenize('# header\nkey: value # note\n')) {
	const show = (trivia: readonly { kind: string; text: string }[]) => trivia.map((t) => `${t.kind} ${JSON.stringify(t.text)}`).join(', ');
	console.log(token.kind.padEnd(10), JSON.stringify(token.text).padEnd(8), 'leading [' + show(token.leadingTrivia) + ']', 'trailing [' + show(token.trailingTrivia) + ']');
}

console.log();
console.log(dump(parse('a: [1, 2] # two\n')));
