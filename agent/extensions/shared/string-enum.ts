import { Type, type TUnsafe } from "typebox";

/**
 * Builds `{ type: "string", enum: [...] }`, the plain enum form every provider accepts.
 *
 * Workaround for https://github.com/earendil-works/pi/issues/11869: pi-ai's
 * `StringEnum` is typed against `@earendil-works/pi-schema`, so TypeBox's `Static`
 * cannot resolve it inside `Type.Object` and tool parameters degrade to `unknown`.
 * Runtime behavior is unaffected; only the published types are wrong.
 *
 * When that issue is fixed, import `StringEnum` from `@earendil-works/pi-ai` in the
 * callers again and delete this file.
 */
export function StringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: [...values],
		...(options?.description ? { description: options.description } : {}),
		...(options?.default ? { default: options.default } : {}),
	});
}
