import { useState } from "react";
import {
  type ActivityTier,
  AmbientGlow,
  type AmbientMood,
  type MotionPreference,
  SegmentedControl,
  StatusOrb,
  Wordmark,
  useMotionPreference,
} from "@/design";
import { BrandSection, ColorSection, SpaceSection, TypeSection } from "./FoundationsSections";
import { BentoHero, LivenessSection, MotionComponentsSection, SharedLayoutSection } from "./MotionSections";
import { ActionsSection, FormsSection, OverlaysSection, SurfacesSection } from "./PrimitivesSections";
import { SIM_RATE, useSimStream } from "./sim";

const NAV = [
  ["brand", "Brand"],
  ["color", "Color"],
  ["type", "Type"],
  ["space", "Space & depth"],
  ["liveness", "Liveness"],
  ["motion", "Motion kit"],
  ["flight", "Shared layout"],
  ["actions", "Actions"],
  ["forms", "Inputs"],
  ["overlays", "Overlays"],
  ["surfaces", "Surfaces"],
] as const;

/** #/design — live showcase of every token, primitive and motion component. */
export default function DesignGallery() {
  const [tier, setTier] = useState<ActivityTier>("busy");
  const [mood, setMood] = useState<AmbientMood>("attention");
  const preference = useMotionPreference((s) => s.preference);
  const setPreference = useMotionPreference((s) => s.setPreference);
  const stream = useSimStream(SIM_RATE[tier]);

  return (
    <div className="relative h-full overflow-y-auto overflow-x-hidden" id="design-scroll">
      <AmbientGlow mood={mood} />
      <div className="relative mx-auto flex max-w-[1560px] gap-8 px-4 pt-5 pb-24 md:px-8 md:pt-8">
        <nav aria-label="Gallery sections" className="sticky top-8 hidden h-fit w-44 shrink-0 flex-col gap-0.5 xl:flex">
          <Wordmark size={24} animated className="mb-5 px-2.5" />
          {NAV.map(([id, label]) => (
            <a key={id} href={`#/design`} onClick={(e) => {
              e.preventDefault();
              document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
            }} className="rounded-sm px-2.5 py-1.5 text-sm font-semibold text-mute transition-colors hover:bg-white/5 hover:text-ink focus-ring">
              {label}
            </a>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col gap-14">
          <header className="flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <span className="kicker flex items-center gap-2">
                <StatusOrb status="running" activity={tier} size={7} label={null} /> Design system · live
              </span>
              <h1 className="text-display md:text-mega">
                Bento <span className="text-omp">× omp</span>
              </h1>
              <p className="max-w-2xl text-sm text-mute md:text-md">
                Tokens, motion and primitives for TeleFlock. Everything below is running for real: change the simulated event rate and watch
                orbs, rings, heartbeats and counters respond.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-tile glass p-3 md:p-4">
              <label className="flex flex-col gap-1.5">
                <span className="kicker">Simulated activity</span>
                <SegmentedControl
                  aria-label="Simulated activity"
                  size="sm"
                  value={tier}
                  onValueChange={setTier}
                  options={(["silent", "calm", "steady", "busy", "frantic"] as const).map((v) => ({ value: v, label: v }))}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="kicker">Ambient mood</span>
                <SegmentedControl
                  aria-label="Ambient mood"
                  size="sm"
                  value={mood}
                  onValueChange={setMood}
                  options={(["calm", "running", "attention", "error"] as const).map((v) => ({ value: v, label: v }))}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="kicker">Motion</span>
                <SegmentedControl<MotionPreference>
                  aria-label="Motion preference"
                  size="sm"
                  value={preference}
                  onValueChange={setPreference}
                  options={[
                    { value: "system", label: "system" },
                    { value: "full", label: "full" },
                    { value: "reduced", label: "reduced" },
                  ]}
                />
              </label>
            </div>
          </header>

          <BentoHero stream={stream} tier={tier} />
          <BrandSection />
          <ColorSection />
          <TypeSection />
          <SpaceSection />
          <LivenessSection stream={stream} tier={tier} />
          <MotionComponentsSection stream={stream} tier={tier} />
          <SharedLayoutSection />
          <ActionsSection />
          <FormsSection />
          <OverlaysSection />
          <SurfacesSection />
        </div>
      </div>
    </div>
  );
}
