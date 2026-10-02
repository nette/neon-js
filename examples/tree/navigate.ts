/**
 * Finding your way in the tree: items by path, nodes by class, the slots of an item, and positions.
 *
 * Usage: npx tsx examples/tree/navigate.ts
 */

import { ArrayItemNode, EntityNode, LiteralNode, parse, StringNode } from '../../src/index.ts';
import { sample } from '../bootstrap.ts';

const doc = parse(sample(`
	database:
		dsn: 'mysql:host=localhost'
		user: root   # change me
	services:
		- App\\Mailer(@smtp)
		cache: App\\Cache(%tempDir%)
`));

// an item by the path of keys, the same keys decode() gives
const user = doc.findItem(['database', 'user'])!;
console.log('key:      ', user.getKeyValue());
console.log('value:    ', user.getValue());
console.log('position: ', user.getPosition());
console.log('comment:  ', user.getTrailingComments().map((c) => c.getCommentText()));

// the slots of an item, each a node or a token
console.log('slots:    ', user.key!.constructor.name, JSON.stringify(user.colon!.text), user.value!.constructor.name);

// nodes by class, anywhere below
for (const entity of doc.find(EntityNode)) {
	const item = entity.findAncestor(ArrayItemNode)!;
	console.log('entity:   ', item.getKeyValue() ?? '(no key)', '->', (entity.value as LiteralNode).token.text);
}
console.log('strings:  ', doc.find(StringNode).map((node) => node.toValue()));
