// Compares the outcome of this parser with the outcome of nette/neon 3.4 written by a PHP run as JSON lines,
// either `php-oracle.php outcomes <dir>` (lines with `file`) or `fuzz.php` (lines with `input` and `seed`).
// Usage: npx tsx tests/differential.ts <outcomes.jsonl>

import { readFileSync } from 'node:fs';
import { NeonError } from '../src/errors.ts';
import { parse } from '../src/parser.ts';
import { decodeUtf8 } from '../src/utf8.ts';
import { equal, toHost, type Typed } from './typed.ts';


interface Outcome {
	file?: string;
	input?: string;
	seed?: number;
	value?: Typed;
	error?: string;
	deviation?: string;
}


/**
 * The deviations the oracle reports, each with what this parser must do instead: accept the input, reject it,
 * or either, when 3.x and the specification read the input differently.
 */
const Deviations: [prefix: string, expected: 'accepted' | 'rejected' | 'either'][] = [
	['a date without offset', 'accepted'], // 3.x adds the zone of the server
	['a lone CR', 'either'], // 3.x strips it before lexing, the specification reads it as a space
	['the quoted token is cut', 'rejected'], // an error inside a string, whose code point position 3.x cannot give
];


const lines = readFileSync(process.argv[2]!, 'utf8').split('\n').filter(Boolean);
const stats = { same: 0, deviation: 0, differs: 0 };
const reasons = (new Map<string, number>);
const differences: string[] = [];
const InvalidDate = Symbol('InvalidDate');

for (const line of lines) {
	const php = JSON.parse(line) as Outcome;
	let actual: string;
	let value;
	try {
		const document = parse(php.input ?? decodeUtf8(readFileSync(php.file!)));
		value = document.toValue();
		actual = 'accepted';
	} catch (e) {
		if (!(e instanceof NeonError)) {
			throw e;
		}
		actual = `${e.message}\n${e.position?.line}:${e.position?.column}\n`;
	}

	let expected: unknown;
	try {
		expected = php.value && toHost(php.value);
	} catch (e) {
		if (!(e instanceof RangeError)) {
			throw e;
		}
		expected = InvalidDate; // 3.x normalizes an invalid date into another one
	}

	let reason: string | null = null;
	if (expected === InvalidDate) {
		reason = actual === 'accepted' ? 'an invalid date normalized by 3.x' : null;
	} else if (php.deviation) {
		const known = Deviations.find(([prefix]) => php.deviation!.startsWith(prefix));
		reason = known && (known[1] === 'either' || (known[1] === 'accepted') === (actual === 'accepted')) ? known[0] : null;
	} else if (php.value ? actual === 'accepted' && equal(value, expected) : actual === php.error) {
		stats.same++;
		continue;
	}

	if (reason) {
		stats.deviation++;
		reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
	} else {
		stats.differs++;
		const expected = php.deviation ? `deviation: ${php.deviation}` : php.error?.trim().replace('\n', ' @ ') ?? 'accepted';
		differences.push(`${php.file ?? `seed ${php.seed} ${JSON.stringify(php.input)}`}\n  php: ${expected}\n  js:  ${actual.trim().replace('\n', ' @ ')}`);
	}
}

console.log(differences.slice(0, 40).join('\n'));
console.log(stats, Object.fromEntries(reasons));
process.exitCode = stats.differs ? 1 : 0;
