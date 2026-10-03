/**
 * The core of a configuration editor: list the options of a file as the fields of a form,
 * apply what the user changed, and save a file whose diff is exactly those changes.
 *
 * Usage: npx tsx examples/config-editor/editor.ts
 */

import { ArrayItemNode, BlockArrayNode, type DocumentNode, InlineArrayNode, parse, type PathSegment } from '../../src/index.ts';
import { printDiff, sample } from '../bootstrap.ts';

const file = sample(`
	# Application settings
	# (edited by hand and by the admin panel)

	mail:
		host: smtp.example.com   # outgoing server
		port: 587
		secure: yes

	cache:
		enabled: true
		ttl: 3600   # seconds
		paths: [temp/cache]
`);

const doc = parse(file);

// 1. the fields of the form: every scalar with its path, its type and its comment
function fields(document: DocumentNode): { path: PathSegment[]; type: string; value: unknown; comment: string }[] {
	const res: ReturnType<typeof fields> = [];
	const walk = (node: unknown, path: PathSegment[]) => {
		if (!(node instanceof BlockArrayNode || node instanceof InlineArrayNode)) {
			return;
		}
		for (const item of node.items as ArrayItemNode[]) {
			const itemPath = [...path, item.getKeyValue() ?? node.items.indexOf(item)];
			const value = item.getValue();
			if (item.value instanceof BlockArrayNode || item.value instanceof InlineArrayNode) {
				walk(item.value, itemPath);
			} else {
				const comment = item.getTrailingComments().map((c) => c.getCommentText()).join(' ');
				res.push({ path: itemPath, type: typeof value, value, comment });
			}
		}
	};
	walk(document.value, []);
	return res;
}

for (const field of fields(doc)) {
	console.log(`${field.path.join('.').padEnd(14)} ${field.type.padEnd(8)} ${String(field.value).padEnd(18)} ${field.comment}`.trimEnd());
}

// 2. what the user submitted: all fields, most of them unchanged
const submitted: Record<string, unknown> = {
	'mail.host': 'smtp.example.com',
	'mail.port': 465,
	'mail.secure': true,
	'cache.enabled': false,
	'cache.ttl': 3600,
	'cache.paths.0': 'temp/cache',
};

for (const [key, value] of Object.entries(submitted)) {
	doc.setValue(key.split('.').map((s) => /^\d+$/.test(s) ? Number(s) : s), value);
}

// 3. save: only what changed is in the diff
console.log();
printDiff(file, doc.print());
