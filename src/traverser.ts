import { ArrayItemNode, type Node, ValueNode } from './nodes.ts';


/** What a visitor returns to steer the walk; symbols, so that no other value means an action by accident. */
export const TraverseAction = Object.freeze({
	SkipChildren: Symbol('SkipChildren'),
	Stop: Symbol('Stop'),
	Remove: Symbol('Remove'),
} as const);

export type TraverseAction = typeof TraverseAction[keyof typeof TraverseAction];

/** What a visitor returns: nothing to go on, a node to take the place of the visited one, or an instruction. */
export type VisitResult = void | ValueNode | TraverseAction;

export type Visitor = (node: Node) => VisitResult;


/**
 * Walks the tree depth-first, calling enter() before the children of a node and leave() after them.
 * The children of a node are taken when it is entered, so nodes inserted around the visited one later
 * are not visited, and a child taken out of the node meanwhile is skipped; a node the visitor takes out
 * of its place itself is neither walked into nor left. A replacement is visited from its children on.
 * Stop ends the walk at once: no node is entered or left after it. The walk is not one atomic edit:
 * the edits before a failure stay.
 */
export class Traverser {
	#stopped = false;

	/** The nodes being walked, from the first one, each with the parent it was entered under. */
	#path: [Node, Node | null][] = [];


	private constructor(
		private readonly enter?: Visitor,
		private readonly leave?: Visitor,
	) {
	}


	static traverse(node: Node, enter?: Visitor, leave?: Visitor): Node | null {
		return new Traverser(enter, leave).visit(node);
	}


	/** Returns the node that stands in the place of the visited one afterwards, null if it was removed or taken out. */
	private visit(node: Node): Node | null {
		const level = this.#path.length;
		this.#path.push([node, node.parent]);
		try {
			let result = this.enter?.(node);
			const current = this.apply(node, result);
			if (!current) {
				return null;
			}
			this.#path[level] = [current, this.#path[level]![1]];
			if (!this.isInPlace(level)) {
				return null;
			} else if (this.#stopped) {
				return current;
			}

			if (result !== TraverseAction.SkipChildren) {
				for (const child of current.getChildren()) {
					if ('getChildren' in child && child.parent === current) { // nodes only, tokens are not visited
						this.visit(child);
						if (this.#stopped) {
							return current;
						} else if (!this.isInPlace(level)) {
							return null;
						}
					}
				}
			}

			result = this.leave?.(current);
			return this.apply(current, result);
		} finally {
			this.#path.pop();
		}
	}


	/** Whether the node at the level and the nodes above it still stand where they were entered. */
	private isInPlace(level: number): boolean {
		for (let i = level; i >= 0; i--) {
			const [node, parent] = this.#path[i]!;
			if (node.parent !== parent) {
				return false;
			}
		}
		return true;
	}


	private apply(node: Node, result: VisitResult): Node | null {
		if (result === TraverseAction.Stop) {
			this.#stopped = true;
		} else if (result === TraverseAction.Remove) {
			if (!(node instanceof ArrayItemNode)) {
				throw new Error('Only an item can be removed; replace any other node.');
			}
			node.remove();
			return null;
		} else if (result instanceof ValueNode) {
			if (!(node instanceof ValueNode)) {
				throw new Error('Only a value node can be replaced.');
			}
			node.replaceWith(result);
			return result;
		}
		return node;
	}
}
