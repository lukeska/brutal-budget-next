import { HttpError } from "./errors";

/** Runs a delete; a foreign-key failure means something still refers to the row. */
export async function runDelete(stmt: D1PreparedStatement): Promise<number> {
  try {
    return (await stmt.run()).meta.changes;
  } catch (err) {
    if (isForeignKeyError(err))
      throw new HttpError(409, "in_use", { message: "Still in use — archive it instead" });
    throw err;
  }
}

export function isForeignKeyError(err: unknown): boolean {
  return err instanceof Error && /FOREIGN KEY constraint failed/i.test(err.message);
}
