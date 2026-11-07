/**
 * Category icons are `@tabler/icons-react` component names stored as plain strings, so names
 * from the old app and from imported files carry over unchanged.
 */

/** The icons the old app offered, in its order. */
export const LEGACY_ICON_NAMES = [
  "IconReceipt2",
  "IconCar",
  "IconShirt",
  "IconCoffee",
  "IconPhone",
  "IconToolsKitchen2",
  "IconDeviceGamepad",
  "IconPlaneTilt",
  "IconShoppingCart",
  "IconGift",
  "IconFirstAidKit",
  "IconBeach",
  "IconHome2",
  "IconMovie",
  "IconDog",
  "IconBallFootball",
  "IconReceiptTax",
  "IconToiletPaper",
  "IconBus",
  "IconBuilding",
  "IconTag",
  "IconArmchair",
  "IconMoodBoy",
  "IconBallBasketball",
  "IconChristmasTree",
  "IconBeer",
  "IconCamera",
  "IconCampfire",
  "IconCreditCard",
  "IconPaw",
  "IconCoins",
  "IconChefHat",
  "IconMicrowave",
  "IconDevices",
  "IconDevices2",
  "IconBolt",
  "IconCpu",
  "IconBoxSeam",
  "IconMoodSmile",
  "IconFish",
  "IconFridge",
  "IconGasStation",
  "IconRadio",
  "IconBarbell",
  "IconThermometer",
  "IconBook",
  "IconDeviceLaptop",
  "IconPigMoney",
  "IconMotorbike",
  "IconBike",
  "IconPaint",
  "IconBallAmericanFootball",
  "IconCut",
  "IconAerialLift",
  "IconSmoking",
  "IconSoccerField",
  "IconShoe",
  "IconTrain",
  "IconSpeedboat",
  "IconFlower",
  "IconIceCream2",
  "IconEyeglass2",
] as const;

/** More icons useful for everyday expenses and income. */
export const EXTRA_ICON_NAMES = [
  "IconCash",
  "IconCashBanknote",
  "IconWallet",
  "IconBuildingBank",
  "IconBriefcase",
  "IconBusinessplan",
  "IconReportMoney",
  "IconChartLine",
  "IconTrendingUp",
  "IconPercentage",
  "IconCalculator",
  "IconReceiptRefund",
  "IconHomeDollar",
  "IconTrophy",
  "IconHeartHandshake",
  "IconRepeat",
  "IconKey",
  "IconTool",
  "IconTools",
  "IconBed",
  "IconWashMachine",
  "IconDroplet",
  "IconFlame",
  "IconWifi",
  "IconDeviceMobile",
  "IconDeviceTv",
  "IconHeadphones",
  "IconBuildingStore",
  "IconBasket",
  "IconHanger",
  "IconBread",
  "IconPizza",
  "IconCake",
  "IconGlassFull",
  "IconGlassCocktail",
  "IconPill",
  "IconStethoscope",
  "IconDental",
  "IconHeart",
  "IconDumbbell",
  "IconSchool",
  "IconBabyCarriage",
  "IconMoodKid",
  "IconMusic",
  "IconTicket",
  "IconPalette",
  "IconBrush",
  "IconPlant",
  "IconUmbrella",
  "IconShieldCheck",
  "IconGavel",
  "IconParking",
  "IconScooter",
  "IconPlane",
  "IconWorld",
] as const;

export const ICON_NAMES = [...LEGACY_ICON_NAMES, ...EXTRA_ICON_NAMES] as const;
export type IconName = (typeof ICON_NAMES)[number];

/** Shown for any stored name that isn't in the list (e.g. from an imported file). */
export const FALLBACK_ICON: IconName = "IconTag";

/** What an icon name must look like to be stored. Unknown names render as the fallback. */
export const ICON_NAME_PATTERN = /^Icon[A-Za-z0-9]{1,60}$/;

export function isKnownIcon(name: string): name is IconName {
  return (ICON_NAMES as readonly string[]).includes(name);
}

/**
 * Category colours: the old app's 17 Tailwind hues, each in shades 300, 500 and 700, as hex.
 * Ordered hue by hue, light to dark.
 */
export const COLOUR_PALETTE = [
  { hue: "red", shades: ["#fca5a5", "#ef4444", "#b91c1c"] },
  { hue: "orange", shades: ["#fdba74", "#f97316", "#c2410c"] },
  { hue: "amber", shades: ["#fcd34d", "#f59e0b", "#b45309"] },
  { hue: "yellow", shades: ["#fde047", "#eab308", "#a16207"] },
  { hue: "lime", shades: ["#bef264", "#84cc16", "#4d7c0f"] },
  { hue: "green", shades: ["#86efac", "#22c55e", "#15803d"] },
  { hue: "emerald", shades: ["#6ee7b7", "#10b981", "#047857"] },
  { hue: "teal", shades: ["#5eead4", "#14b8a6", "#0f766e"] },
  { hue: "cyan", shades: ["#67e8f9", "#06b6d4", "#0e7490"] },
  { hue: "sky", shades: ["#7dd3fc", "#0ea5e9", "#0369a1"] },
  { hue: "blue", shades: ["#93c5fd", "#3b82f6", "#1d4ed8"] },
  { hue: "indigo", shades: ["#a5b4fc", "#6366f1", "#4338ca"] },
  { hue: "violet", shades: ["#c4b5fd", "#8b5cf6", "#6d28d9"] },
  { hue: "purple", shades: ["#d8b4fe", "#a855f7", "#7e22ce"] },
  { hue: "fuchsia", shades: ["#f0abfc", "#d946ef", "#a21caf"] },
  { hue: "pink", shades: ["#f9a8d4", "#ec4899", "#be185d"] },
  { hue: "rose", shades: ["#fda4af", "#f43f5e", "#be123c"] },
] as const;

export const COLOURS: readonly string[] = COLOUR_PALETTE.flatMap((h) => h.shades);

/** Any `#rrggbb` colour can be stored; the palette is what the picker offers. */
export const HEX_COLOUR_PATTERN = /^#[0-9a-fA-F]{6}$/;
