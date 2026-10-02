/**
 * Encoding JavaScript values as NEON, inline and as blocks, and which strings get quotes.
 *
 * Usage: npx tsx examples/encoding/encode.ts
 */

import { Chain, encode, Entity, NeonDate } from '../../src/index.ts';

const config = {
	database: { dsn: 'mysql:host=localhost', user: 'root', options: { lazy: true } },
	services: [new Entity('App\\Mailer', ['@smtp', { timeout: 30 }])],
	factory: new Entity(Chain, [new Entity('@builder', []), new Entity('::create', [1])]),
	started: new NeonDate(2016, 6, 3, 19, 0, 0, null, '+02:00'),
	limit: 12345678901234567890n,
	note: 'first line\nsecond line',
};

console.log(encode(config));
console.log();
console.log(encode(config, true));

// which arrays are blocks: only the first level, or all but lists
console.log(encode({ database: config.database, hosts: ['alpha', 'beta'] }, (_, path) => !path.length));
console.log(encode({ database: config.database, hosts: ['alpha', 'beta'] }, (v) => !Array.isArray(v)));

// a string is written without quotes only if it reads back as the same string
for (const value of ['plain words', 'yes', 'On', '1.5', '-.5', '2016-06-03', 'a: b', 'a#b', 'a #b', '', ' padded', 'tab\there', 'bell\u0007']) {
	console.log(JSON.stringify(value).padEnd(14), '->', encode(value));
}
