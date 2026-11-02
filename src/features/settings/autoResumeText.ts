import type { AutoResumeConfig, BootService } from "@/core/gen";

/**
 * The host's own mechanism (`BootService.kind`): what the Settings row calls it, what it is made of and when it brings agents back. A
 * Mac or a Windows PC starts nothing before the user logs in. A daemon from before the field only ever installed systemd timers.
 */
const BOOT_KINDS: Record<string, { noun: string; made: string; when: string }> = {
  systemd: { noun: "boot service", made: "a systemd timer", when: "after a reboot" },
  launchd: { noun: "login item", made: "a launchd agent", when: "once you log in again after a reboot" },
  taskScheduler: { noun: "login task", made: "a Task Scheduler task", when: "once you log in again after a reboot" },
};

function bootName(boot: BootService | undefined): { noun: string; made: string; when: string } {
  const kind = BOOT_KINDS[boot?.kind ?? "systemd"];
  return kind ? { ...kind, made: ` (${kind.made})` } : { noun: "boot service", made: "", when: "after a reboot" };
}

/** What the host's Auto-resume row says: the host's own notice first (its settings file was unreadable, so both settings are off). */
export function autoResumeDescription(config: AutoResumeConfig): string {
  return config.notice ?? (config.enabled ? "Stopped agents here resume once usage is back." : "Agents here stay stopped until you resume them.");
}

/** Whether the host can install a boot service (`bootService`, from its scheduler: a systemd timer with root or lingering, a launchd agent on macOS, a Task Scheduler task on Windows). A host that reports none is taken to (older daemons). */
export function bootServiceAvailable(config: AutoResumeConfig | null): boolean {
  const boot = config?.bootService;
  return boot === undefined || boot.available;
}

/**
 * What "Bring agents back after a reboot" says about this host: what is installed and when it brings agents back (and the host's own
 * note: on a Mac or a Windows PC that nothing starts before login), or why nothing can be (no systemd, no lingering, a development home).
 */
export function bringBackDescription(config: AutoResumeConfig): string {
  const boot = config.bootService;
  if (boot && !boot.available) return boot.note ?? "Not available on this host.";
  const { noun, made, when } = bootName(boot);
  const note = boot?.note ? ` ${boot.note}` : "";
  if (config.bringBack !== true) return `No ${noun}. Agents come back after a reboot once TeleFlock or tf-hostd runs on the host again.`;
  if (boot?.installed) {
    return `A ${noun}${made} is installed on this host, so agents that were running come back ${when}, even with TeleFlock closed. Switch off to remove it.${note}`;
  }
  return `Installs a ${noun} on this host${made} while agents are running or waiting to come back, so they come back ${when}, even with TeleFlock closed. Switch off to remove it.${note}`;
}
