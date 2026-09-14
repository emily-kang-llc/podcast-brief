import "server-only";
import { NextResponse } from "next/server";
// Thrown by libs/briefs/service.js and converted to a JSON response by
// handleRouteError. `code` is stable and machine-readable; `message` is for
// humans; `extra` is merged into the body (e.g. credits_needed).
export class ApiError extends Error {
  constructor(code, status, message, extra = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
  toJSON() {
    return { error: this.code, message: this.message, ...this.extra };
  }
}
export function jsonError(status, code, message, extra = {}) {
  return NextResponse.json({ error: code, message, ...extra }, { status });
}
export function handleRouteError(err, routeName) {
  if (err instanceof ApiError) {
    return NextResponse.json(err.toJSON(), { status: err.status });
  }
  console.error(`Unhandled error in ${routeName}:`, err);
  return jsonError(500, "internal_error", "Internal server error");
}