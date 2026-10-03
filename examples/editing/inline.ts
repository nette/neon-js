/**
 * Inline arrays: an item is added with the separator its neighbours use, on its own line in an
 * array that spans lines, and the trailing comma stays where it was.
 *
 * Usage: npx tsx examples/editing/inline.ts
 */

import { parse } from '../../src/index.ts';
import { printDiff, sample } from '../bootstrap.ts';

const text = sample(`
	roles: [guest, member]
	hosts: [
		alpha,
		beta,
	]
	limits: {cpu: 2, memory: 512}
	empty: []
`);

const doc = parse(text);
doc.addItem(['roles'], 'admin');
doc.addItem(['roles'], 'root', { position: 0 });
doc.addItem(['hosts'], 'gamma');
doc.setValue(['limits', 'disk'], 100);
doc.removeItem(['limits', 'cpu']);
doc.addItem(['empty'], 'first');

printDiff(text, doc.print());
