/**
 * TeleFlock design system. Import everything from "@/design".
 * CSS entry (tokens, utilities, keyframes): "@/design/styles/index.css" — imported once in main.tsx.
 */

// tokens & helpers
export { STATUS, STATUSES, MOBILE_MAX_WIDTH, color, gradient, radius, z } from "./tokens";
export type { Status, StatusMeta } from "./tokens";
export { cn } from "./lib/cn";
export { useNow, onFrame } from "./lib/clock";
export type { FrameCallback } from "./lib/clock";
export { useMediaQuery, useIsMobile, useFinePointer, useInView, useMinWidth, useIdleReady } from "./lib/hooks";
export { isTauri, isAndroid, isWindows, hasCustomWindowChrome } from "./lib/platform";
export { useWindowActive, useWindowVisible } from "./lib/windowActive";
export { formatElapsed, formatAge, formatCompact, formatUsd, formatInt } from "./lib/format";
export { hashString, seededRandom } from "./lib/hash";
export { DesignProvider } from "./DesignProvider";

// motion & liveness
export { spring, tween, pressMotion, fadeRise, popIn } from "./motion/springs";
export { MotionProvider, useCalmMotion, useLivelyMotion, useMotionLevel } from "./motion/MotionProvider";
export { useMotionPreference, applyInitialMotionAttribute } from "./motion/preference";
export type { MotionPreference, MotionLevel } from "./motion/preference";
export { useActivity, tierForRate, BREATH_SECONDS } from "./motion/activity";
export type { ActivityTier } from "./motion/activity";
export { StatusOrb } from "./motion/StatusOrb";
export type { StatusOrbProps } from "./motion/StatusOrb";
export { ProgressRing } from "./motion/ProgressRing";
export { Heartbeat } from "./motion/Heartbeat";
export type { HeartbeatProps } from "./motion/Heartbeat";
export { StreamText, Caret, Shimmer } from "./motion/StreamText";
export { NumberTicker } from "./motion/NumberTicker";
export { Elapsed } from "./motion/Elapsed";
export { TiltCard } from "./motion/TiltCard";
export { GlowBorder } from "./motion/GlowBorder";
export { AmbientGlow, moodFor } from "./motion/AmbientGlow";
export type { AmbientMood } from "./motion/AmbientGlow";
export { Swarm } from "./motion/Swarm";
export { Sparkline } from "./motion/Sparkline";
export { FlockSky } from "./motion/FlockSky";
export { Skeleton } from "./motion/Skeleton";
export { CardFlight, cardLayoutId, FlightGroup, LayoutGroup, AnimatePresence } from "./motion/layout";
export { morphTo, MORPH_PARTS } from "./motion/morph";
export type { MorphPart } from "./motion/morph";

// brand
export { LogoMark, Wordmark } from "./brand/Logo";
export { AgentGlyph, agentGlyphTheme } from "./brand/AgentGlyph";

// primitives
export { Button, IconButton } from "./ui/Button";
export type { ButtonProps, ButtonVariant, ButtonSize, IconButtonProps } from "./ui/Button";
export { Chip, Badge, CountBadge, Kbd, StatusPill } from "./ui/Chip";
export { Tile, Card } from "./ui/Tile";
export type { TileVariant } from "./ui/Tile";
export { Input, Textarea, Field } from "./ui/Field";
export { Select } from "./ui/Select";
export type { SelectOption } from "./ui/Select";
export { Switch } from "./ui/Switch";
export { SegmentedControl } from "./ui/SegmentedControl";
export type { SegmentOption } from "./ui/SegmentedControl";
export { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/Tabs";
export { Tooltip, TooltipProvider } from "./ui/Tooltip";
export { Dialog, DialogTrigger, DialogClose, DialogContent, overlayClass } from "./ui/Dialog";
export { BottomSheet } from "./ui/BottomSheet";
export { Popover, PopoverTrigger, PopoverAnchor, PopoverClose, PopoverContent } from "./ui/Popover";
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuGroup,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuGroup,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "./ui/Menu";
export { Toaster, toast, dismissToast, useToastStore } from "./ui/Toast";
export type { ToastInput } from "./ui/Toast";
export { ScrollArea } from "./ui/ScrollArea";
export { EmptyState } from "./ui/EmptyState";
export { Spinner } from "./ui/Spinner";
export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from "./ui/Command";
export { TitleBar } from "./ui/TitleBar";
export { PageHeader } from "./ui/PageHeader";
export type { PageHeaderProps } from "./ui/PageHeader";
export { Lightbox, LightboxTrigger } from "./ui/Lightbox";
export type { LightboxImage, LightboxProps, LightboxTriggerProps } from "./ui/Lightbox";
