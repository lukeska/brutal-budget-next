import type { CategoryType } from "./schema";

/** A starter category; `icon` is a `@tabler/icons-react` component name. Children inherit the colour. */
export type DefaultCategory = {
  name: string;
  icon: string;
  colour: string;
  children?: { name: string; icon: string }[];
};

export const DEFAULT_CATEGORIES: Record<CategoryType, DefaultCategory[]> = {
  expense: [
    {
      name: "Housing",
      icon: "IconHome2",
      colour: "#1971c2",
      children: [
        { name: "Rent & mortgage", icon: "IconKey" },
        { name: "Maintenance", icon: "IconTool" },
      ],
    },
    {
      name: "Food",
      icon: "IconToolsKitchen2",
      colour: "#e8590c",
      children: [
        { name: "Groceries", icon: "IconShoppingCart" },
        { name: "Restaurants", icon: "IconToolsKitchen2" },
      ],
    },
    { name: "Transport", icon: "IconBus", colour: "#0c8599" },
    { name: "Bills & Utilities", icon: "IconReceipt2", colour: "#5f3dc4" },
    { name: "Health", icon: "IconFirstAidKit", colour: "#c2255c" },
    { name: "Shopping", icon: "IconShirt", colour: "#9c36b5" },
    { name: "Leisure", icon: "IconMovie", colour: "#f08c00" },
    { name: "Travel", icon: "IconPlaneTilt", colour: "#1098ad" },
    { name: "Gifts", icon: "IconGift", colour: "#e03131" },
    { name: "Other", icon: "IconTag", colour: "#868e96" },
  ],
  income: [
    { name: "Salary", icon: "IconCash", colour: "#2f9e44" },
    { name: "Bonus", icon: "IconTrophy", colour: "#66a80f" },
    { name: "Interest", icon: "IconPigMoney", colour: "#099268" },
    { name: "Gifts received", icon: "IconGift", colour: "#d6336c" },
    { name: "Other income", icon: "IconTag", colour: "#868e96" },
  ],
};
