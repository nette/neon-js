import type { Position } from './token.ts';


/** Computes positions of increasing UTF-16 offsets in one pass. */
export class Cursor {
	#index = 0;
	#line = 1;
	#column = 1;
	#offset = 0;


	constructor(
		private readonly s: string,
	) {
	}


	at(index: number): Position {
		if (index < this.#index) {
			this.#index = 0;
			this.#line = 1;
			this.#column = 1;
			this.#offset = 0;
		}

		const s = this.s;
		for (let i = this.#index; i < index; i++) {
			const code = s.charCodeAt(i);
			if (code === 10) {
				this.#line++;
				this.#column = 1;
				this.#offset++;
			} else if (code >= 0xDC00 && code <= 0xDFFF && i > 0 && isHighSurrogate(s.charCodeAt(i - 1))) {
				// second half of a code point
			} else {
				this.#column++;
				this.#offset++;
			}
		}

		this.#index = index;
		return Object.freeze({ line: this.#line, column: this.#column, offset: this.#offset, utf16Offset: index });
	}
}


function isHighSurrogate(code: number): boolean {
	return code >= 0xD800 && code <= 0xDBFF;
}
