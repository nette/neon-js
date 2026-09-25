import { type BlockFilter, encode as encodeValue, type EncodeOptions } from './encoder.ts';
import type { Node } from './nodes.ts';
import { parse } from './parser.ts';
import { Chain, type NeonValue } from './values.ts';


/** Parses NEON and returns its value. */
export function decode(input: string): NeonValue {
	return parse(input).toValue();
}


/**
 * Writes a value as NEON. In block mode, arrays are written one item per line; a function
 * `blockMode(value, path)` is asked for every array and writes it as a block if true.
 */
export function encode(value: unknown, blockMode: boolean | BlockFilter | EncodeOptions = false, indentation = '\t'): string {
	return encodeValue(value, typeof blockMode === 'object' ? blockMode : { blockMode, indentation });
}


/** The facade, read as `Neon.decode(text)` like in PHP. */
export const Neon = {
	decode,
	encode,
	parse,
	print: (node: Node): string => node.print(),
	Chain,
} as const;
