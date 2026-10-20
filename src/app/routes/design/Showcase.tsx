import type { ReactNode } from "react";
import { cn } from "@/design";

/** A gallery section with an anchor, kicker and title. */
export function Section({ id, kicker, title, description, children, className }: {
  id: string;
  kicker: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn("scroll-mt-6", className)}>
      <div className="mb-4 flex flex-col gap-1">
        <span className="kicker">{kicker}</span>
        <h2 id={`${id}-title`} className="text-2xl md:text-3xl">
          {title}
        </h2>
        {description && <p className="max-w-3xl text-sm text-mute">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** Labelled demo cell. */
export function Demo({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3 rounded-xl well p-4", className)}>
      <span className="font-mono text-2xs text-mute-2">{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}
