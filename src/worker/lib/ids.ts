import { v7 } from "uuid";

/** A new time-ordered UUIDv7 primary key. */
export function newId(): string {
  return v7();
}
