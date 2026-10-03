/**
 * The corners of the format that a tool meets in real files, and what the library does with them.
 *
 * Usage: npx tsx examples/edge-cases/edges.ts
 */

import { decode, encode, NeonError, parse } from '../../src/index.ts';

const show = (label: string, text: string) => {
	try {
		console.log(label.padEnd(26), JSON.stringify(decode(text)));
	} catch (e) {
		console.log(label.padEnd(26), (e as NeonError).toString());
	}
};

show('BOM and CRLF', '\uFEFFa: 1\r\nb: 2\r\n');
show('dash subblock', 'list:\n- a\n- b\nnext: 1');
show('block on a dash, tab', '- a: 1\n\tb: 2');
show('block on a dash, 2 spaces', '- a: 1\n  b: 2');
show('block on a dash, 4 spaces', '- a: 1\n    b: 2');
show('value on the next line', 'a:\n\tx');
show('multiline indentation', 'a: \'\'\'\n\t\tdeeper\n\tshallower\n\'\'\'');
show('words that are not bool', '[on, off, tRuE]');
show('implicit keys', '{5: a, b}');

// edits keep what is not edited, the missing final line ending included
const doc = parse('a: 1\r\nb: 2');
doc.setValue(['c'], 3);
console.log('\nadd to CRLF without EOL  ', JSON.stringify(doc.print()));

// a value whose first line starts with spaces is written so that it reads back the same
const value = '  indented first line\nsecond';
console.log('encode leading spaces    ', JSON.stringify(encode(value)), decode(encode(value)) === value);
