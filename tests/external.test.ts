import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { NeonError } from '../src/errors.ts';
import { parse } from '../src/parser.ts';
import { decodeUtf8 } from '../src/utf8.ts';
import { findNeonFiles } from './corpus.ts';


// NEON_EXTERNAL_CORPUS lists directories of real-world .neon files, separated by ; or ,
// The parity of values and errors with nette/neon 3.x is checked by tests/differential.ts.
const dirs = (process.env.NEON_EXTERNAL_CORPUS ?? '').split(/[;,]/).filter(Boolean);


test.skipIf(!dirs.length)('round trip over the external corpus', () => {
	let files = 0;
	let rejected = 0;
	for (const dir of dirs) {
		for (const file of findNeonFiles(dir)) {
			files++;
			let input;
			try {
				input = decodeUtf8(readFileSync(file));
				const document = parse(input);
				document.toValue();
				expect(document.print(), file).toBe(input);
			} catch (e) {
				if (!(e instanceof NeonError)) {
					throw e;
				}
				rejected++;
			}
		}
	}
	expect(files).toBeGreaterThan(0);
	console.log(`${files} files, ${rejected} rejected`);
}, 600_000);
