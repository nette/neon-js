import { NeonError } from './errors.ts';
import { Scanner } from './scanner.ts';
import { Cursor } from './position.ts';
import { type Position, type Token, Trivia, trustedToken } from './token.ts';


/**
 * Splits the input into tokens with their trivia attached. The last token is EndOfFile.
 * Printing all tokens in order gives back the input.
 */
export function tokenize(input: string): Token[] {
	checkWellFormed(input);

	const scanner = new Scanner(input);
	const cursor = new Cursor(input);
	const tokens: Token[] = [];
	let pending: Trivia[] = []; // trivia not yet attached
	let last: { leading: Trivia[]; trailing: Trivia[]; kind: Token['kind']; text: string; origin: Position } | null = null;

	const flush = () => {
		if (last) {
			tokens.push(trustedToken(last.kind, last.text, last.leading, last.trailing, last.origin));
		}
	};

	while (true) {
		const item = scanner.next();
		if (!item) {
			if (scanner.errorAt >= 0) {
				throw new NeonError(`Unexpected '${quote(input.slice(scanner.errorAt))}'`, cursor.at(scanner.errorAt));
			}
			break;
		}

		const text = input.slice(item.start, item.end);
		if (item.kind === 'Trivia') {
			const trivia = new Trivia(item.triviaKind!, text);
			// trailing trivia of the last token run up to and including the first line ending
			if (last && !pending.length && !last.trailing.some((t) => t.kind === 'LineEnding')) {
				last.trailing.push(trivia);
			} else {
				pending.push(trivia);
			}
		} else {
			flush();
			last = { kind: item.kind, text, leading: pending, trailing: [], origin: cursor.at(item.start) };
			pending = [];
		}
	}

	flush();
	tokens.push(trustedToken('EndOfFile', '', pending, [], cursor.at(input.length)));
	return tokens;
}


/** Text quoted by 'Unexpected': cut to 40 code points, a line ending counting as one, shown as <new line>. */
export function quote(text: string): string {
	return Array.from(text.replaceAll('\r\n', '\n')).slice(0, 40).join('').replaceAll('\n', '<new line>');
}


function checkWellFormed(input: string): void {
	if (!input.isWellFormed()) {
		const i = input.search(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
		throw new NeonError('Invalid UTF-8 sequence.', new Cursor(input).at(i));
	}
}
