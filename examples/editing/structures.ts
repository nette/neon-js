/**
 * Replacing a value by a structure and back: an empty option becomes a block indented like the
 * rest of the file, a block becomes a scalar, and an entity of the DI container is edited inside.
 *
 * Usage: npx tsx examples/editing/structures.ts
 */

import { parse } from '../../src/index.ts';
import { printDiff, sample } from '../bootstrap.ts';

const text = sample(`
	application:
	    mapping: App\\*Module\\Presenters\\*Presenter

	services:
	    mailer: App\\Mailer(@smtp, timeout: 30)

	session:
	    expiration: 14 days
	    autoStart: true
	includes:
`);

const doc = parse(text);
doc.setValue(['includes'], ['services.neon', 'local.neon']);
doc.setValue(['application', 'mapping'], { '*': 'App\\*Module\\**Presenter' });
doc.setValue(['services', 'mailer', 'timeout'], 60);
doc.setValue(['session'], null);

printDiff(text, doc.print());
