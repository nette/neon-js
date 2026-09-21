import { describe, expect, test } from 'vitest';
import { NeonError } from '../src/errors.ts';
import { tokenize } from '../src/lexer.ts';
import { Token, Trivia } from '../src/token.ts';
import { loadCases } from './corpus.ts';


const print = (tokens: Token[]) => tokens.map(String).join('');

const short = (tokens: Token[]) => tokens.map((t) => [
	...t.leadingTrivia.map((tr) => '<' + tr.kind + ':' + JSON.stringify(tr.text)),
	t.kind + ':' + JSON.stringify(t.text),
	...t.trailingTrivia.map((tr) => '>' + tr.kind + ':' + JSON.stringify(tr.text)),
].join(' '));


describe('round trip of tokens over the corpus', () => {
	for (const category of ['decode', 'roundtrip', 'cst']) {
		test.each(loadCases(category).map((c) => [c.name, c.read('.neon')!]))(`${category}/%s`, (_, input) => {
			expect(print(tokenize(input))).toBe(input);
		});
	}
});


test('trivia attach by the convention', () => {
	expect(short(tokenize('a: 1 # c\n\n# d\n\tb\n'))).toEqual([
		'Literal:"a"',
		'Colon:":" >Whitespace:" "',
		'Literal:"1" >Whitespace:" " >Comment:"# c" >LineEnding:"\\n"',
		'<LineEnding:"\\n" <Comment:"# d" <LineEnding:"\\n" <Whitespace:"\\t" Literal:"b" >LineEnding:"\\n"',
		'EndOfFile:""',
	]);

	expect(short(tokenize('\uFEFF# x\r\na # y'))).toEqual([
		'<ByteOrderMark:"\uFEFF" <Comment:"# x" <LineEnding:"\\r\\n" Literal:"a" >Whitespace:" " >Comment:"# y"',
		'EndOfFile:""',
	]);

	expect(short(tokenize(''))).toEqual(['EndOfFile:""']);
});


test('scanner rules', () => {
	const kinds = (s: string) => tokenize(s).map((t) => t.kind + ' ' + t.text).slice(0, -1);
	expect(kinds('a:b - c -d :e')).toEqual(['Literal a:b - c -d', 'Literal :e']);
	expect(kinds('- a: -')).toEqual(['Dash -', 'Literal a', 'Colon :', 'Dash -']);
	expect(kinds('\'a\'-b')).toEqual(['String \'a\'', 'Dash -', 'Literal b']);
	expect(kinds('a #b')).toEqual(['Literal a']);
	expect(kinds('[a#b]')).toEqual(['OpenBracket [', 'Literal a#b', 'CloseBracket ]']);
	expect(kinds('\'\'\'abc\'')).toEqual(['String \'\'\'abc\'']);
	expect(kinds('\'\'\'\'')).toEqual(['String \'\'\'\'']);
	expect(kinds('\'\'\'\n  a\n  \'\'\'x')).toEqual(['String \'\'\'\n  a\n  \'\'\'', 'Literal x']);
	expect(kinds('a\rb')).toEqual(['Literal a\rb']);
	expect(kinds('a:\r b')).toEqual(['Literal a', 'Colon :', 'Literal b']);
	expect(kinds('"a\\"b" "\\\\"')).toEqual(['String "a\\"b"', 'String "\\\\"']);
});


test('origin positions in code points', () => {
	const tokens = tokenize('ž: 🐴\r\n  b');
	expect(tokens.map((t) => t.origin)).toEqual([
		{ line: 1, column: 1, offset: 0, utf16Offset: 0 },
		{ line: 1, column: 2, offset: 1, utf16Offset: 1 },
		{ line: 1, column: 4, offset: 3, utf16Offset: 3 },
		{ line: 2, column: 3, offset: 8, utf16Offset: 9 },
		{ line: 2, column: 4, offset: 9, utf16Offset: 10 },
	]);
});


test('errors of the scanner', () => {
	const error = (s: string) => {
		try {
			tokenize(s);
		} catch (e) {
			if (e instanceof NeonError) {
				return [e.message, e.position?.line, e.position?.column];
			}
			throw e;
		}
		return null;
	};

	expect(error('x: `y`')).toEqual(['Unexpected \'`y`\'', 1, 4]);
	expect(error('\'abc\ndef\'')).toEqual(['Unexpected \'\'abc<new line>def\'\'', 1, 1]);
	expect(error('"a\\\nb"')).toEqual(['Unexpected \'"a\\<new line>b"\'', 1, 1]);
	expect(error('\'\'\'\n  abc\r\n')).toEqual(['Unexpected \'\'\'\'<new line>  abc<new line>\'', 1, 1]);
	expect(error('`' + 'ž'.repeat(50))).toEqual(['Unexpected \'`' + 'ž'.repeat(39) + '\'', 1, 1]);
	expect(error('a: \uD800')).toEqual(['Invalid UTF-8 sequence.', 1, 4]);
});


test('Token.fromText() and setText()', () => {
	expect(Token.fromText('abc').kind).toBe('Literal');
	expect(Token.fromText(':').kind).toBe('Colon');
	expect(Token.fromText('\'a\'').kind).toBe('String');
	expect(() => Token.fromText('a b c,')).toThrow(TypeError);
	expect(() => Token.fromText(' a')).toThrow(TypeError);
	expect(() => Token.fromText('#a')).toThrow(TypeError);

	const token = Token.fromText('abc');
	expect(token.setText('x y').text).toBe('x y');
	expect(() => token.setText('\'q\'')).toThrow(TypeError);
});


test('canonical form of trivia', () => {
	const token = Token.fromText('a');
	const space = Trivia.fromText(' ');
	const comment = Trivia.fromText('# c');
	const eol = Trivia.fromText('\n');

	expect(() => token.setTrailingTrivia([space, comment, eol])).not.toThrow();
	expect(() => token.setTrailingTrivia([eol, space])).toThrow('last');
	expect(() => token.setTrailingTrivia([space, space])).toThrow('next to each other');
	expect(() => token.setLeadingTrivia([comment])).toThrow('followed by a line ending');
	expect(() => token.setLeadingTrivia([eol, Trivia.fromText('\uFEFF')])).toThrow('byte order mark');
	expect(() => Trivia.fromText('\n\n')).toThrow(TypeError);
	expect(comment.getCommentText()).toBe('c');

	const endsWithCr = Trivia.fromText('# c\r'); // a lone CR is text of the comment
	expect(() => token.setTrailingTrivia([space, endsWithCr])).not.toThrow();
	expect(() => token.setTrailingTrivia([space, endsWithCr, eol])).toThrow('one line ending');
	expect(() => token.setTrailingTrivia([space, endsWithCr, Trivia.fromText('\r\n')])).not.toThrow();
});
