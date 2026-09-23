import { NeonError } from './errors.ts';
import { Cursor } from './position.ts';


const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });


/** Decodes UTF-8 bytes; invalid ones fail with the position of the first invalid byte. */
export function decodeUtf8(bytes: Uint8Array): string {
	try {
		return decoder.decode(bytes);
	} catch {
		let valid = 0;
		for (let n; (n = sequenceLength(bytes, valid)); valid += n) { ; }
		const prefix = decoder.decode(bytes.subarray(0, valid));
		throw new NeonError('Invalid UTF-8 sequence.', new Cursor(prefix).at(prefix.length));
	}
}


/** Ranges of the bytes of the well-formed sequences, by the first byte (Unicode table 3-7). */
const Sequences: [number, number, [number, number][]][] = [
	[0x00, 0x7F, []],
	[0xC2, 0xDF, [[0x80, 0xBF]]],
	[0xE0, 0xE0, [[0xA0, 0xBF], [0x80, 0xBF]]],
	[0xE1, 0xEC, [[0x80, 0xBF], [0x80, 0xBF]]],
	[0xED, 0xED, [[0x80, 0x9F], [0x80, 0xBF]]],
	[0xEE, 0xEF, [[0x80, 0xBF], [0x80, 0xBF]]],
	[0xF0, 0xF0, [[0x90, 0xBF], [0x80, 0xBF], [0x80, 0xBF]]],
	[0xF1, 0xF3, [[0x80, 0xBF], [0x80, 0xBF], [0x80, 0xBF]]],
	[0xF4, 0xF4, [[0x80, 0x8F], [0x80, 0xBF], [0x80, 0xBF]]],
];


/** Length of the well-formed sequence at the offset, or 0. */
function sequenceLength(bytes: Uint8Array, i: number): number {
	const first = bytes[i];
	const sequence = first === undefined ? undefined : Sequences.find(([lo, hi]) => first >= lo && first <= hi);
	if (!sequence) {
		return 0;
	}
	const rest = sequence[2];
	return rest.every(([lo, hi], k) => {
		const b = bytes[i + k + 1];
		return b !== undefined && b >= lo && b <= hi;
	})
		? rest.length + 1
		: 0;
}
