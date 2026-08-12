import type { Context, MiddlewareHandler } from "hono";
import type { Hex } from "viem";
import { AppError, Kind } from "./error.js";

/** Bearer token auth middleware for internal routes. Any failure answers a
 * bare 401 with a WWW-Authenticate challenge, matching the Rust guard —
 * one uniform response, no error body to distinguish failure modes. */
export function bearerAuth(expectedToken: string): MiddlewareHandler {
	return async (c, next) => {
		const header = c.req.header("Authorization");
		// RFC 7235: the auth scheme name is case-insensitive ("Bearer" ==
		// "bearer"); the token itself is not. Split at the first space only,
		// so a token containing spaces still compares whole.
		const space = header?.indexOf(" ") ?? -1;
		const authorized =
			header !== undefined &&
			space > 0 &&
			header.slice(0, space).toLowerCase() === "bearer" &&
			header.slice(space + 1) === expectedToken;

		if (!authorized) {
			c.header("WWW-Authenticate", "Bearer");
			return c.body(null, 401);
		}

		await next();
	};
}

/** Extracts and validates the X-Signature header: hex with an optional 0x
 * prefix, exactly 65 bytes. Failures are invalidSignature, as in Rust's
 * signature_from_header. */
export function extractSignature(c: Context): Hex {
	const sig = c.req.header("X-Signature");
	if (!sig) {
		throw new AppError(Kind.InvalidSignature, "missing X-Signature header");
	}
	if (!/^(0x)?([0-9a-fA-F]{2})*$/.test(sig)) {
		throw new AppError(Kind.InvalidSignature, "X-Signature is not valid hex");
	}
	const bare = sig.startsWith("0x") ? sig.slice(2) : sig;
	if (bare.length !== 130) {
		throw new AppError(Kind.InvalidSignature, "invalid signature bytes");
	}
	return `0x${bare}` as Hex;
}
