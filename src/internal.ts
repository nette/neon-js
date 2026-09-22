/** Keys of the members that only the tree itself may call. They are not exported from the package. */
export const setParent: unique symbol = Symbol('setParent');
export const setItems: unique symbol = Symbol('setItems');
export const setSlots: unique symbol = Symbol('setSlots');
export const setLeading: unique symbol = Symbol('setLeading');
export const setTrailing: unique symbol = Symbol('setTrailing');
export const forgetOrigin: unique symbol = Symbol('forgetOrigin');


let journal: (() => void)[] | null = null;


/** Notes how to undo a write of the tree, while an atomic() operation runs. */
export function record(undo: () => void): void {
	journal?.push(undo);
}


/** Runs an operation; if it throws, every write it made is undone, so a refused operation changes nothing. */
export function atomic<T>(operation: () => T): T {
	if (journal) {
		return operation();
	}
	const list: (() => void)[] = journal = [];
	try {
		return operation();
	} catch (e) {
		journal = null;
		for (let i = list.length - 1; i >= 0; i--) {
			list[i]!();
		}
		throw e;
	} finally {
		journal = null;
	}
}
