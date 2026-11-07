import { z } from "zod";
import { HEX_COLOUR_PATTERN, ICON_NAME_PATTERN } from "../icons";
import type { CurrencyCode } from "../money";
import type { Entry } from "./entry";

/** Category payloads shared by the API and the client. */

export const CATEGORY_TYPES = ["expense", "income"] as const;
export type CategoryType = (typeof CATEGORY_TYPES)[number];

export const NAME_MAX = 60;

const refId = z.string().min(1).max(64);
export const displayName = z.string().trim().min(1, "Name is required").max(NAME_MAX);
export const iconName = z.string().regex(ICON_NAME_PATTERN, "Unknown icon");
export const hexColour = z.string().regex(HEX_COLOUR_PATTERN, "Expected a #rrggbb colour");

/**
 * A top-level category needs an icon and a colour. A subcategory never stores a colour (it
 * always uses its parent's) and its icon defaults to the parent's.
 */
export const categoryCreateSchema = z
  .object({
    id: z.uuidv7(),
    type: z.enum(CATEGORY_TYPES),
    parentId: refId.nullish(),
    name: displayName,
    icon: iconName.optional(),
    colour: hexColour.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.parentId) {
      if (v.colour !== undefined)
        ctx.addIssue({ code: "custom", path: ["colour"], message: "A subcategory uses its parent's colour" });
      return;
    }
    if (v.icon === undefined) ctx.addIssue({ code: "custom", path: ["icon"], message: "Pick an icon" });
    if (v.colour === undefined) ctx.addIssue({ code: "custom", path: ["colour"], message: "Pick a colour" });
  });
export type CategoryCreate = z.infer<typeof categoryCreateSchema>;

/** A partial edit. A category can't move between levels, so `parentId` isn't editable. */
export const categoryPatchSchema = z.object({
  version: z.number().int().positive(),
  name: displayName.optional(),
  icon: iconName.optional(),
  colour: hexColour.optional(),
  archived: z.boolean().optional(),
});
export type CategoryPatch = z.infer<typeof categoryPatchSchema>;

export const versionQuerySchema = z.object({ version: z.coerce.number().int().positive() });

export const categoryMergeSchema = z.object({
  targetId: refId,
  version: z.number().int().positive(),
});
export type CategoryMerge = z.infer<typeof categoryMergeSchema>;

export const categorySummaryQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(36).default(12),
  /** Month whose entries are listed; defaults to the current month. */
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
});

export interface Category {
  id: string;
  type: CategoryType;
  parentId: string | null;
  name: string;
  icon: string;
  /** For a subcategory, its parent's colour. */
  colour: string;
  archived: boolean;
  archivedAt: string | null;
  /** Entries filed directly on this category (not its subcategories). */
  entryCount: number;
  version: number;
}

export interface CategoryNode extends Category {
  children: Category[];
}

export interface MonthTotal {
  month: string;
  totalMinor: number;
}

export interface CategorySummary {
  category: CategoryNode;
  baseCurrency: CurrencyCode;
  /** Oldest first, one per month including empty ones. Subcategory totals roll up into a parent. */
  months: MonthTotal[];
  month: string;
  /** The selected month split by the category itself and each subcategory. */
  breakdown: { categoryId: string; totalMinor: number }[];
  entries: Entry[];
}

export interface CategoryMergeResult {
  targetId: string;
  movedEntries: number;
  movedChildren: number;
}
