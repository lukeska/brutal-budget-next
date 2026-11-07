import { z } from "zod";
import type { CurrencyCode } from "../money";
import { displayName, hexColour } from "./category";
import type { Entry } from "./entry";

/** Projects: colour-coded tags for expenses and income, such as "Japan trip". */

export const projectCreateSchema = z.object({
  id: z.uuidv7(),
  name: displayName,
  colour: hexColour,
});
export type ProjectCreate = z.infer<typeof projectCreateSchema>;

export const projectPatchSchema = z.object({
  version: z.number().int().positive(),
  name: displayName.optional(),
  colour: hexColour.optional(),
  archived: z.boolean().optional(),
});
export type ProjectPatch = z.infer<typeof projectPatchSchema>;

/** Totals are in the household base currency and leave out entries still waiting for a rate. */
export interface ProjectTotals {
  /** The household base currency the totals are in. */
  baseCurrency: CurrencyCode;
  incomeMinor: number;
  expenseMinor: number;
  /** Income minus expense. */
  netMinor: number;
}

export interface Project extends ProjectTotals {
  id: string;
  name: string;
  colour: string;
  archived: boolean;
  archivedAt: string | null;
  entryCount: number;
  version: number;
}

export interface ProjectSummary extends ProjectTotals {
  project: Project;
  entries: Entry[];
}
