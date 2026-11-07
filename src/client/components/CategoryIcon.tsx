import { FALLBACK_ICON, type IconName, isKnownIcon } from "@shared/icons";
import {
  type Icon,
  IconAerialLift,
  IconArmchair,
  IconBabyCarriage,
  IconBallAmericanFootball,
  IconBallBasketball,
  IconBallFootball,
  IconBarbell,
  IconBasket,
  IconBeach,
  IconBed,
  IconBeer,
  IconBike,
  IconBolt,
  IconBook,
  IconBoxSeam,
  IconBread,
  IconBriefcase,
  IconBrush,
  IconBuilding,
  IconBuildingBank,
  IconBuildingStore,
  IconBus,
  IconBusinessplan,
  IconCake,
  IconCalculator,
  IconCamera,
  IconCampfire,
  IconCar,
  IconCash,
  IconCashBanknote,
  IconChartLine,
  IconChefHat,
  IconChristmasTree,
  IconCoffee,
  IconCoins,
  IconCpu,
  IconCreditCard,
  IconCut,
  IconDental,
  IconDeviceGamepad,
  IconDeviceLaptop,
  IconDeviceMobile,
  IconDevices,
  IconDevices2,
  IconDeviceTv,
  IconDog,
  IconDroplet,
  IconDumbbell,
  IconEyeglass2,
  IconFirstAidKit,
  IconFish,
  IconFlame,
  IconFlower,
  IconFridge,
  IconGasStation,
  IconGavel,
  IconGift,
  IconGlassCocktail,
  IconGlassFull,
  IconHanger,
  IconHeadphones,
  IconHeart,
  IconHeartHandshake,
  IconHome2,
  IconHomeDollar,
  IconIceCream2,
  IconKey,
  IconMicrowave,
  IconMoodBoy,
  IconMoodKid,
  IconMoodSmile,
  IconMotorbike,
  IconMovie,
  IconMusic,
  IconPaint,
  IconPalette,
  IconParking,
  IconPaw,
  IconPercentage,
  IconPhone,
  IconPigMoney,
  IconPill,
  IconPizza,
  IconPlane,
  IconPlaneTilt,
  IconPlant,
  IconRadio,
  IconReceipt2,
  IconReceiptRefund,
  IconReceiptTax,
  IconRepeat,
  IconReportMoney,
  IconSchool,
  IconScooter,
  IconShieldCheck,
  IconShirt,
  IconShoe,
  IconShoppingCart,
  IconSmoking,
  IconSoccerField,
  IconSpeedboat,
  IconStethoscope,
  IconTag,
  IconThermometer,
  IconTicket,
  IconToiletPaper,
  IconTool,
  IconTools,
  IconToolsKitchen2,
  IconTrain,
  IconTrendingUp,
  IconTrophy,
  IconUmbrella,
  IconWallet,
  IconWashMachine,
  IconWifi,
  IconWorld,
} from "@tabler/icons-react";
import type { CSSProperties } from "react";
import { cn } from "../lib/cn";

/**
 * Every icon a category can pick, imported by name so the bundle carries only these. Typed by
 * `IconName`, so adding a name to the shared list without importing it here fails to compile.
 */
export const ICON_COMPONENTS: Record<IconName, Icon> = {
  IconReceipt2,
  IconCar,
  IconShirt,
  IconCoffee,
  IconPhone,
  IconToolsKitchen2,
  IconDeviceGamepad,
  IconPlaneTilt,
  IconShoppingCart,
  IconGift,
  IconFirstAidKit,
  IconBeach,
  IconHome2,
  IconMovie,
  IconDog,
  IconBallFootball,
  IconReceiptTax,
  IconToiletPaper,
  IconBus,
  IconBuilding,
  IconTag,
  IconArmchair,
  IconMoodBoy,
  IconBallBasketball,
  IconChristmasTree,
  IconBeer,
  IconCamera,
  IconCampfire,
  IconCreditCard,
  IconPaw,
  IconCoins,
  IconChefHat,
  IconMicrowave,
  IconDevices,
  IconDevices2,
  IconBolt,
  IconCpu,
  IconBoxSeam,
  IconMoodSmile,
  IconFish,
  IconFridge,
  IconGasStation,
  IconRadio,
  IconBarbell,
  IconThermometer,
  IconBook,
  IconDeviceLaptop,
  IconPigMoney,
  IconMotorbike,
  IconBike,
  IconPaint,
  IconBallAmericanFootball,
  IconCut,
  IconAerialLift,
  IconSmoking,
  IconSoccerField,
  IconShoe,
  IconTrain,
  IconSpeedboat,
  IconFlower,
  IconIceCream2,
  IconEyeglass2,
  IconCash,
  IconCashBanknote,
  IconWallet,
  IconBuildingBank,
  IconBriefcase,
  IconBusinessplan,
  IconReportMoney,
  IconChartLine,
  IconTrendingUp,
  IconPercentage,
  IconCalculator,
  IconReceiptRefund,
  IconHomeDollar,
  IconTrophy,
  IconHeartHandshake,
  IconRepeat,
  IconKey,
  IconTool,
  IconTools,
  IconBed,
  IconWashMachine,
  IconDroplet,
  IconFlame,
  IconWifi,
  IconDeviceMobile,
  IconDeviceTv,
  IconHeadphones,
  IconBuildingStore,
  IconBasket,
  IconHanger,
  IconBread,
  IconPizza,
  IconCake,
  IconGlassFull,
  IconGlassCocktail,
  IconPill,
  IconStethoscope,
  IconDental,
  IconHeart,
  IconDumbbell,
  IconSchool,
  IconBabyCarriage,
  IconMoodKid,
  IconMusic,
  IconTicket,
  IconPalette,
  IconBrush,
  IconPlant,
  IconUmbrella,
  IconShieldCheck,
  IconGavel,
  IconParking,
  IconScooter,
  IconPlane,
  IconWorld,
};

/** The component for a stored icon name; names outside the list (e.g. from an import) get the tag icon. */
export function iconComponent(name: string): Icon {
  return ICON_COMPONENTS[isKnownIcon(name) ? name : FALLBACK_ICON];
}

type CategoryIconProps = {
  icon: string;
  /** The category's colour (a subcategory passes its parent's). */
  colour?: string | null;
  /** "badge" puts the icon on a soft square of the colour; "plain" just tints the icon. */
  variant?: "badge" | "plain";
  size?: "sm" | "md" | "lg";
  className?: string;
  /** Accessible name; omit when the category name is shown next to it. */
  label?: string;
};

const BOX = { sm: "size-7", md: "size-9", lg: "size-12" } as const;
const GLYPH = { sm: 16, md: 20, lg: 26 } as const;

/** A category's Tabler line icon, coloured by its category. */
export function CategoryIcon({
  icon,
  colour,
  variant = "badge",
  size = "md",
  className,
  label,
}: CategoryIconProps) {
  const Glyph = iconComponent(icon);
  const glyph = <Glyph size={GLYPH[size]} stroke={1.5} aria-hidden="true" />;
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true };
  if (variant === "plain") {
    return (
      <span
        {...a11y}
        className={cn("inline-flex shrink-0", className)}
        style={{ color: colour ?? undefined }}
      >
        {glyph}
      </span>
    );
  }
  const style: CSSProperties | undefined = colour
    ? { color: colour, backgroundColor: `color-mix(in srgb, ${colour} 16%, transparent)` }
    : undefined;
  return (
    <span
      {...a11y}
      className={cn("inline-flex shrink-0 items-center justify-center bg-surface", BOX[size], className)}
      style={style}
    >
      {glyph}
    </span>
  );
}

/** A small square of a category or project colour. */
export function ColourDot({ colour, className }: { colour: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-3 shrink-0", className)}
      style={{ backgroundColor: colour }}
    />
  );
}
