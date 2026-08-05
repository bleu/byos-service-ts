import type { Context, MiddlewareHandler } from "hono";
import type { Hex } from "viem";
import { AppError, Kind } from "./error.js";

/** Bearer token auth middleware for internal routes. */
export function bearerAuth(expectedToken: string): MiddlewareHandler {
	return async (c, next) => {
		const header = c.req.header("Authorization");
		if (!header) {
			c.header("WWW-Authenticate", "Bearer");
			return c.json({ kind: Kind.BadRequest, description: "Missing Authorization header" }, 401);
		}

		const parts = header.split(" ");
		if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") {
			c.header("WWW-Authenticate", "Bearer");
			return c.json({ kind: Kind.BadRequest, description: "Invalid Authorization header" }, 401);
		}

		if (parts[1] !== expectedToken) {
			c.header("WWW-Authenticate", "Bearer");
			return c.json({ kind: Kind.BadRequest, description: "Invalid bearer token" }, 401);
		}

		await next();
	};
}

/** Extracts the X-Signature header, throws AppError if missing. */
export function extractSignature(c: Context): Hex {
	const sig = c.req.header("X-Signature");
	if (!sig) {
		throw new AppError(Kind.BadRequest, "Missing X-Signature header");
	}
	return sig as Hex;
}
