/**
 * Decoding NEON into JavaScript values, and what an error says.
 *
 * Usage: npx tsx examples/parsing/decode.ts
 */

import { decode, Entity, NeonDate, NeonError } from '../../src/index.ts';
import { sample } from '../bootstrap.ts';

const config = decode(sample(`
	# a typical configuration
	application:
		debug: yes
		port: 0x1F90
		started: 2016-06-03 19:00:00 +02:00
		hosts: [alpha, beta]
	services:
		- Mailer(@smtp, timeout: 30)
	big: 12345678901234567890
`)) as Record<string, Record<string, unknown> | unknown[] | bigint>;

const app = config.application as Record<string, unknown>;
console.log('debug:  ', app.debug);
console.log('port:   ', app.port);
console.log('started:', app.started instanceof NeonDate, String(app.started));
console.log('hosts:  ', app.hosts);
const mailer = (config.services as Entity[])[0]!;
console.log('service:', mailer instanceof Entity, mailer.value, mailer.attributes);
console.log('big:    ', typeof config.big, config.big);

try {
	decode('a: 1\n  b: 2');
} catch (e) {
	if (e instanceof NeonError) {
		console.log('\n' + e.message, e.position);
		console.log(String(e));
	}
}
