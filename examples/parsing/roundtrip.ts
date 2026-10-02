/**
 * Parsing into the syntax tree and printing it back: byte for byte, whatever the file looks like.
 *
 * Usage: npx tsx examples/parsing/roundtrip.ts
 */

import { parse } from '../../src/index.ts';

const files = [
	'﻿# BOM, CRLF, a comment at the end\r\nkey: value # here\r\n',
	'tabs:\n\t- a\nspaces:\n    - b: 1\n      # a comment where you would not expect one\n      c: 2\n',
	'no final line ending:   [a ,b,c ,]',
	'multiline: \'\'\'\n\t  keeps\n\tits indentation\n\'\'\'\n\n\n',
];

for (const text of files) {
	const document = parse(text);
	console.log(document.print() === text, JSON.stringify(document.toValue()));
}
