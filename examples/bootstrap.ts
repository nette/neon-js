// Helpers shared by the examples.


/** Removes the common indentation and the first and last line break of a template, like a heredoc. */
export function sample(text: string): string {
	const lines = text.replace(/^\n/, '').replace(/\n[\t ]*$/, '').split('\n');
	const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => /^\t*/.exec(line)![0].length));
	return lines.map((line) => line.slice(indent)).join('\n') + '\n';
}


/** Prints the lines that differ, as - and +, so you see that nothing else changed. */
export function printDiff(before: string, after: string): void {
	const a = before.split('\n');
	const b = after.split('\n');
	// longest common subsequence of lines
	const lcs = a.map(() => new Array<number>(b.length + 1).fill(0));
	lcs.push(new Array<number>(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
		}
	}

	const show = (line: string) => line.replaceAll('\r', '\\r');
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			i++;
			j++;
		} else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
			console.log('- ' + show(a[i++]!));
		} else {
			console.log('+ ' + show(b[j++]!));
		}
	}
}
