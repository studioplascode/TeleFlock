import { ArrowRight, FlaskConical, Network } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import { AmbientGlow, cn, FlockSky, LogoMark, spring, StatusOrb, TiltCard, toast } from "@/design";
import { core, useUi } from "@/core";
import type { HostProfile } from "@/core/gen";
import { errorHint, errorMessage } from "@/features/shell/errors";
import { haptic } from "@/features/shell/haptics";

const DEMO_PROFILE: HostProfile = {
  id: "demo",
  name: "Demo flock",
  kind: "demo",
  herdrSession: "default",
  autoConnect: true,
  color: "#f053d0",
};

const FEATURES = [
  { status: "running" as const, text: "Every agent on one live board" },
  { status: "needs-you" as const, text: "Answer questions from anywhere" },
  { status: "review" as const, text: "Review, commit and ship" },
];

/** First run (no hosts saved): add your herdr host, or try the simulated demo flock. */
export function Onboarding() {
  const { openDialog } = useUi();
  const [starting, setStarting] = useState(false);

  const tryDemo = () => {
    setStarting(true);
    haptic("success");
    core
      .app("hosts.save", DEMO_PROFILE)
      .then((saved) => core.app("hosts.connect", { hostId: saved.id }))
      .catch((err: unknown) => {
        setStarting(false);
        toast({ title: `Couldn't start the demo: ${errorMessage(err)}`, description: errorHint(err), status: "error" });
      });
  };

  return (
    <div className="relative h-full overflow-y-auto overscroll-contain">
      <AmbientGlow mood="running" />
      <FlockSky className="fixed" />
      <div className="grid min-h-full place-items-center px-5 pt-[max(40px,env(safe-area-inset-top))] pb-[max(40px,env(safe-area-inset-bottom))]">
      <div className="flex w-full max-w-[760px] flex-col items-center text-center">
        <motion.div initial={{ scale: 0.4, opacity: 0, rotate: -12 }} animate={{ scale: 1, opacity: 1, rotate: 0 }} transition={spring.bouncy} className="relative">
          <span className="absolute inset-0 -z-10 rounded-full bg-accent/40 blur-3xl tf-loop animate-pulse" aria-hidden />
          <LogoMark size={88} animated />
        </motion.div>
        <motion.h1
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...spring.smooth, delay: 0.12 }}
          className="mt-6 font-display text-hero font-bold md:text-mega"
        >
          Your agents, <span className="text-omp">herded.</span>
        </motion.h1>
        <motion.p initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring.smooth, delay: 0.2 }} className="mt-3 max-w-md text-md text-mute">
          TeleFlock is a live window into the omp agents running in herdr on your machines, on your desk and in your pocket.
        </motion.p>
        <motion.ul
          initial="hidden"
          animate="show"
          variants={{ show: { transition: { staggerChildren: 0.07, delayChildren: 0.3 } } }}
          className="mt-5 flex flex-wrap justify-center gap-2"
        >
          {FEATURES.map((f) => (
            <motion.li
              key={f.text}
              variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: spring.smooth } }}
              className="flex items-center gap-2 rounded-full bg-white/5 px-3 py-1.5 text-xs font-semibold text-ink-2 shadow-hairline"
            >
              <StatusOrb status={f.status} size={7} label={null} />
              {f.text}
            </motion.li>
          ))}
        </motion.ul>

        <div className="mt-9 grid w-full gap-4 md:grid-cols-2">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring.smooth, delay: 0.42 }}>
            <TiltCard className="h-full rounded-tile">
              <button
                type="button"
                onClick={() => {
                  haptic("select");
                  openDialog({ kind: "hostEditor" });
                }}
                className="group flex h-full w-full flex-col items-start gap-3 rounded-tile p-6 text-left text-white pressable focus-ring [background:radial-gradient(110%_120%_at_100%_0%,rgb(240_83_208/0.9)_0%,transparent_60%),linear-gradient(135deg,#a15eef,#7fa2e7)] shadow-[inset_0_1px_0_rgb(255_255_255/0.3),var(--shadow-glow-accent)]"
              >
                <span className="grid size-11 place-items-center rounded-lg bg-white/20 [&_svg]:size-5">
                  <Network />
                </span>
                <span className="font-display text-2xl font-bold">Add your herdr host</span>
                <span className="text-sm text-white/85">Over Tailscale SSH, no keys to copy. On desktop also this computer, or a WSL distro on Windows.</span>
                <span className="mt-auto inline-flex items-center gap-1.5 pt-2 text-sm font-extrabold">
                  Set it up <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
                </span>
              </button>
            </TiltCard>
          </motion.div>
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring.smooth, delay: 0.5 }}>
            <TiltCard className="h-full rounded-tile">
              <button
                type="button"
                onClick={tryDemo}
                disabled={starting}
                className={cn("tile group flex h-full w-full flex-col items-start gap-3 p-6 text-left pressable focus-ring", starting && "opacity-80")}
              >
                <span className="grid size-11 place-items-center rounded-lg bg-accent/18 text-accent-hi [&_svg]:size-5">
                  <FlaskConical />
                </span>
                <span className="font-display text-2xl font-bold text-ink">Try the demo</span>
                <span className="text-sm text-mute">A simulated flock of ten agents streaming, asking and shipping. Nothing leaves the app.</span>
                <span className="mt-auto inline-flex items-center gap-1.5 pt-2 text-sm font-extrabold text-accent-hi">
                  {starting ? "Hatching the flock…" : "Take a look"} <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
                </span>
              </button>
            </TiltCard>
          </motion.div>
        </div>
      </div>
      </div>
    </div>
  );
}
