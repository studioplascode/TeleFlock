import { describe, expect, test } from "bun:test";
import type { AutoResumeConfig } from "@/core/gen";
import { autoResumeDescription, bootServiceAvailable, bringBackDescription } from "./autoResumeText";

const config = (over: Partial<AutoResumeConfig> = {}): AutoResumeConfig => ({ enabled: true, bringBack: true, ...over });

describe("Auto-resume settings wording", () => {
  test("a host whose settings file was unreadable says so instead of a plain 'off'", () => {
    const damaged = config({ enabled: false, bringBack: false, notice: "The auto-resume settings file could not be read (EOF), so both are off." });
    expect(autoResumeDescription(damaged)).toContain("could not be read");
    expect(autoResumeDescription(config({ enabled: false }))).toBe("Agents here stay stopped until you resume them.");
    expect(autoResumeDescription(config())).toBe("Stopped agents here resume once usage is back.");
  });

  test("a host that can install a boot service says what it installs, and whether it is there", () => {
    const planned = config({ bootService: { available: true, installed: false } });
    expect(bootServiceAvailable(planned)).toBe(true);
    expect(bringBackDescription(planned)).toContain("Installs a boot service");
    const installed = config({ bootService: { available: true, installed: true } });
    expect(bringBackDescription(installed)).toContain("is installed on this host");
    expect(bringBackDescription(config({ bringBack: false, bootService: { available: true, installed: false } })).startsWith("No boot service.")).toBe(true);
    const broken = config({ bootService: { available: true, installed: false, note: "The systemd timer is not active (boom)." } });
    expect(bringBackDescription(broken)).toContain("boom");
  });

  test("macOS, Windows and Linux without systemd say it is not available there, never that it installs a service", () => {
    const none = config({ bootService: { available: false, installed: false, note: "Not available on this host: boot services are only installed with systemd on Linux (this host runs macos)." } });
    expect(bootServiceAvailable(none)).toBe(false);
    expect(bringBackDescription(none).startsWith("Not available on this host")).toBe(true);
    expect(bringBackDescription(none)).not.toContain("Installs a boot service");
    // The reason stands whatever the stored setting says.
    expect(bringBackDescription({ ...none, bringBack: false }).startsWith("Not available on this host")).toBe(true);
    expect(bringBackDescription(config({ bootService: { available: false, installed: false } }))).toBe("Not available on this host.");
  });

  test("a daemon that reports no boot service keeps the setting as it was", () => {
    expect(bootServiceAvailable(config())).toBe(true);
    expect(bootServiceAvailable(null)).toBe(true);
    expect(bringBackDescription(config())).toContain("Installs a boot service");
  });
});
