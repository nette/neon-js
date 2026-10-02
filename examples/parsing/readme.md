# Parsing: values, the tree, and errors that say where

Two ways in. `decode()` gives you the value, the way `JSON.parse()` does. `parse()` gives you
the syntax tree, and the tree prints back as exactly the text it came from.

**You will learn:**

- what JavaScript values NEON maps to: numbers, `bigint`, `NeonDate`, `Entity`
- what an error tells you, and where
- that printing a parsed document gives back every byte of it

```shell
npx tsx examples/parsing/decode.ts
npx tsx examples/parsing/roundtrip.ts
```

## Values (decode.ts)

```
debug:   true
port:    8080
started: true 2016-06-03 19:00:00 +0200
hosts:   [ 'alpha', 'beta' ]
service: true Mailer { '0': '@smtp', timeout: 30 }
big:     bigint 12345678901234567890n

Bad indentation { line: 2, column: 3, offset: 7, utf16Offset: 7 }
Bad indentation on line 2 at column 3
```

`yes` is `true` and `0x1F90` is `8080`. A date is a `NeonDate`, the components as written, so a
date without an offset does not silently get the time zone of the machine; `toDate()` turns it
into an instant when you say in which zone. `Mailer(@smtp, timeout: 30)` is an `Entity`, the
value and the attributes, which is how the DI container of Nette writes a service. An integer
too big for a `number` is a `bigint`, not a rounded number.

An error is a `NeonError` with the message and the position, in code points; `toString()` joins
them the way the PHP library always did.

## The tree prints back as it was (roundtrip.ts)

```
true {"key":"value"}
true {"tabs":["a"],"spaces":[{"b":1,"c":2}]}
true {"no final line ending":["a","b","c"]}
true {"multiline":"keeps\n\tits indentation"}
```

A byte order mark, CRLF, tabs in one section and spaces in another, a comment in an odd place,
spaces around commas, no line ending at the end: `print(parse(text)) === text` for every input
NEON accepts. That is what makes the editing in the next chapters possible: nothing that is in
the file is lost on the way through the tree.
