/**
 * Adding items: a new key gets the indentation of its siblings, a list item its dash, a missing
 * section is created under the key that exists, and a typo in a path fails instead of adding a key.
 *
 * Usage: npx tsx examples/editing/adding.ts
 */

import { parse } from '../../src/index.ts';
import { printDiff, sample } from '../bootstrap.ts';

const text = sample(`
	parameters:
	    mail: info@example.com

	services:
		- App\\Model\\UserFacade

	extensions:
`);

const doc = parse(text);
doc.setValue(['parameters', 'admin'], 'admin@example.com');
doc.addItem(['services'], 'App\\Model\\OrderFacade');
doc.setValue(['extensions', 'console'], 'Contributte\\Console\\DI\\ConsoleExtension');

printDiff(text, doc.print());

try {
	doc.setValue(['parametres', 'admin'], 'x');
} catch (e) {
	console.log('\n' + String(e));
}
try {
	doc.setValue(['parameters', 'amdin'], 'x', { create: false });
} catch (e) {
	console.log(String(e));
}
