import { encode } from './encoder.ts';
import { forgetOrigin, setItems, setLeading, setSlots, setTrailing } from './internal.ts';
import type { ArrayItemNode, ArrayNode, ValueNode } from './nodes.ts';
import { parse } from './parser.ts';
import { NeonError } from './errors.ts';
import { isIntegerKey } from './values.ts';


/** Where a built node will stand. */
export interface Place {
	/** Write arrays as blocks. */
	block: boolean;
	/** Indentation of the line of the item that will hold the value. */
	indent: string;
	/** Indentation unit of nested blocks. */
	unit: string;
	/** Line ending of the document. */
	eol: string;
	/** Write multiline strings in """, because a ''' would close an earlier string of the document. */
	doubleQuoted?: boolean;
}


/**
 * Makes nodes from values of the host. The text is what encode() writes, so new values look the
 * same as encoded ones; it is parsed, so the nodes are valid by construction.
 */
export class Builder {
	/** A value as a node, without edge trivia; a non-empty array is a block if the place allows it. */
	static value(value: unknown, place: Place): ValueNode {
		const block = place.block && isCollection(value) && hasItems(value);
		let text = encode(value, { blockMode: block, indentation: place.unit, doubleQuotedMultiline: place.doubleQuoted });
		text = block
			? indent(text.replace(/\n+$/, ''), place.indent + place.unit, true)
			: indent(text, place.indent, false);
		const node = Builder.parse(text.replaceAll('\n', place.eol));
		if (!block) {
			node.getFirstToken()[setLeading]([]);
		}
		node.getLastToken()[setTrailing]([]);
		return node;
	}


	/** An item of a block, `key: value` or `- value`, with its indentation and line ending. */
	static blockItem(key: string | null, value: unknown, place: Place): ArrayItemNode {
		const head = key === null ? '-' : Builder.keyText(key) + ':';
		let text: string;
		if (value === null && key !== null) {
			text = head;
		} else if (isCollection(value) && hasItems(value)) {
			const body = encode(value, { blockMode: true, indentation: place.unit, doubleQuotedMultiline: place.doubleQuoted }).replace(/\n+$/, '');
			text = head + '\n' + indent(body, place.unit, true);
		} else {
			text = head + ' ' + encode(value, { indentation: place.unit, doubleQuotedMultiline: place.doubleQuoted });
		}
		const block = Builder.parse(indent(text, place.indent, true).replaceAll('\n', place.eol) + place.eol) as ArrayNode;
		const item = block.items[0]!;
		block[setItems]([]);
		return item;
	}


	/** @internal The value of a document made of the text, detached, its tokens without an origin. */
	static parse(text: string): ValueNode {
		const document = parse(text);
		const node = document.value!;
		document[setSlots]({ value: null });
		for (const token of node.getTokens()) {
			token[forgetOrigin]();
		}
		return node;
	}


	/** The text of a key: an integer key as digits, anything else as a string. */
	static keyText(key: string): string {
		if (key.includes('\n')) {
			throw new NeonError('A key cannot contain a line break.');
		}
		return isIntegerKey(key) ? key : encode(key);
	}
}


/** A non-empty array, Map or plain object. */
function hasItems(value: unknown): boolean {
	return value instanceof Map ? value.size > 0 : Array.isArray(value) ? value.length > 0 : Object.keys(value as object).length > 0;
}


function isCollection(value: unknown): boolean {
	if (value instanceof Map || Array.isArray(value)) {
		return true;
	}
	const proto = typeof value === 'object' && value !== null ? Object.getPrototypeOf(value) : undefined;
	return proto === Object.prototype || proto === null;
}


/** Prefixes non-empty lines; the first one only if asked. */
function indent(text: string, prefix: string, first: boolean): string {
	return text.split('\n').map((line, i) => line === '' || (i === 0 && !first) ? line : prefix + line).join('\n');
}
