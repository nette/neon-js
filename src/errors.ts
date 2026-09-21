import type { Position } from './token.ts';


/** Error of the scanner, the parser or the evaluation of values. */
export class NeonError extends Error {
	override name = 'NeonError';


	constructor(
		message: string,
		readonly position: Position | null = null,
	) {
		super(message);
	}


	override toString(): string {
		return this.position
			? `${this.message} on line ${this.position.line} at column ${this.position.column}`
			: this.message;
	}
}
