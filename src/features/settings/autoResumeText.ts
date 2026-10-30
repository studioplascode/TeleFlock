import type { AutoResumeConfig } from "@/core/gen";

/** What the host's Auto-resume row says: the host's own notice first (its settings file was unreadable, so both settings are off). */
export function autoResumeDescription(config: AutoResumeConfig): string {
  return config.notice ?? (config.enabled ? "Stopped agents here resume once usage is back." : "Agents here stay stopped until you resume them.");
}

/** Whether the host can install a boot service (`bootService`, from its scheduler: systemd with root or lingering). A host that reports none is taken to (older daemons). */
export function bootServiceAvailable(config: AutoResumeConfig | null): boolean {
  const boot = config?.bootService;
  return boot === undefined || boot.available;
}

/** What "Bring agents back after a reboot" says about this host: what is installed, or why nothing can be (macOS, Windows, no systemd, no lingering). */
export function bringBackDescription(config: AutoResumeConfig): string {
  const boot = config.bootService;
  if (boot && !boot.available) return boot.note ?? "Not available on this host.";
  if (config.bringBack !== true) return "No boot service. Agents come back after a reboot once TeleFlock or tf-hostd runs on the host again.";
  if (boot?.installed) {
    return "A boot service (a systemd timer) is installed on this host, so agents that were running come back after a reboot even with TeleFlock closed. Switch off to remove it.";
  }
  return `Installs a boot service on this host (a systemd timer) while agents are running or waiting to come back, so they come back after a reboot even with TeleFlock closed. Switch off to remove it.${boot?.note ? ` ${boot.note}` : ""}`;
}
