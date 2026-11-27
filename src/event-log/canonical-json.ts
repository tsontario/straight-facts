export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * Serializes a JSON value with object keys sorted, so equal values always
 * produce identical text and therefore identical hashes.
 *
 * Throws on anything that JSON would silently drop or cannot represent:
 * `undefined`, functions, symbols, bigints, non-finite numbers, array holes,
 * extra properties on arrays, symbol-keyed properties, and objects that are
 * not plain objects (for example `Date` or class instances). Negative zero is
 * written as `0`, as `JSON.stringify` writes it.
 */
export function canonicalJson(value: unknown): string {
	return serialize(value, "$");
}

function serialize(value: unknown, path: string): string {
	if (value === null) return "null";
	switch (typeof value) {
		case "boolean":
			return value ? "true" : "false";
		case "number":
			if (!Number.isFinite(value)) throw new TypeError(`${path}: number must be finite`);
			return JSON.stringify(value);
		case "string":
			return JSON.stringify(value);
		case "object": {
			if (Object.getOwnPropertySymbols(value).length > 0) {
				throw new TypeError(`${path}: symbol-keyed properties are not JSON`);
			}
			if (Array.isArray(value)) {
				const keys = Object.keys(value);
				if (keys.length !== value.length || keys.some((key, i) => key !== String(i))) {
					throw new TypeError(`${path}: arrays must have no holes and no extra properties`);
				}
				return `[${value.map((item, i) => serialize(item, `${path}[${i}]`)).join(",")}]`;
			}
			const proto: unknown = Object.getPrototypeOf(value);
			if (proto !== Object.prototype && proto !== null) {
				throw new TypeError(`${path}: only plain objects are allowed`);
			}
			const record = value as Record<string, unknown>;
			const fields = Object.keys(record)
				.sort()
				.map(key => `${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`)}`);
			return `{${fields.join(",")}}`;
		}
		default:
			throw new TypeError(`${path}: ${typeof value} is not JSON`);
	}
}
