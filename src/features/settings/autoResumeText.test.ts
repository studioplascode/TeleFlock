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
    expect(bringBackDescription(installed)).toContain("come back after a reboot, even with TeleFlock closed");
    expect(bringBackDescription(config({ bringBack: false, bootService: { available: true, installed: false } })).startsWith("No boot service.")).toBe(true);
    const broken = config({ bootService: { available: true, installed: false, note: "The systemd timer is not active (boom)." } });
    expect(bringBackDescription(broken)).toContain("boom");
  });

  test("a host with no mechanism of its own, or a development home, says it is not available, never that it installs a service", () => {
    const none = config({ bootService: { available: false, installed: false, note: "Not available on this host: there is no systemd to install a boot service in, so agents come back after a reboot once TeleFlock or tf-hostd runs here again." } });
    expect(bootServiceAvailable(none)).toBe(false);
    expect(bringBackDescription(none).startsWith("Not available on this host")).toBe(true);
    expect(bringBackDescription(none)).not.toContain("Installs a");
    // The reason stands whatever the stored setting says.
    expect(bringBackDescription({ ...none, bringBack: false }).startsWith("Not available on this host")).toBe(true);
    expect(bringBackDescription(config({ bootService: { available: false, installed: false } }))).toBe("Not available on this host.");
    const lab = config({ bootService: { available: false, installed: false, kind: "launchd", note: "Not installed by this tf-hostd home: only the default home (~/.teleflock) installs a login item." } });
    expect(bootServiceAvailable(lab)).toBe(false);
    expect(bringBackDescription(lab).startsWith("Not installed by this tf-hostd home")).toBe(true);
  });

  test("a Mac names its login item and says when it runs, installed or not", () => {
    const note = "Starts when you log in to this Mac, then every 10 minutes; starting before login is not offered.";
    const planned = config({ bootService: { available: true, installed: false, kind: "launchd", note } });
    expect(bootServiceAvailable(planned)).toBe(true);
    expect(bringBackDescription(planned).startsWith("Installs a login item on this host (a launchd agent) while agents are running or waiting to come back")).toBe(true);
    expect(bringBackDescription(planned).endsWith(note)).toBe(true);
    const installed = config({ bootService: { available: true, installed: true, kind: "launchd", note } });
    expect(bringBackDescription(installed).startsWith("A login item (a launchd agent) is installed on this host")).toBe(true);
    expect(bringBackDescription(installed).endsWith(note)).toBe(true);
    expect(bringBackDescription(installed)).toContain("come back once you log in again after a reboot");
    expect(bringBackDescription(installed)).not.toContain("systemd");
    expect(bringBackDescription({ ...installed, bringBack: false }).startsWith("No login item.")).toBe(true);
  });

  test("a Windows host names its Task Scheduler task, and a broken one says why", () => {
    const installed = config({ bootService: { available: true, installed: true, kind: "taskScheduler", note: "Starts when you log in to Windows, then every 10 minutes; starting before login is not offered." } });
    expect(bringBackDescription(installed).startsWith("A login task (a Task Scheduler task) is installed on this host")).toBe(true);
    const broken = config({ bootService: { available: true, installed: false, kind: "taskScheduler", note: "The Task Scheduler task is not active (schtasks /Create failed: ERROR: Access is denied.). Automations run while tf-hostd runs." } });
    expect(bringBackDescription(broken)).toContain("Access is denied");
    expect(bringBackDescription(broken)).not.toContain("systemd");
  });

  test("a kind this app does not know is a boot service without a name for what it is made of", () => {
    const later = config({ bootService: { available: true, installed: true, kind: "somethingNew" } });
    expect(bringBackDescription(later).startsWith("A boot service is installed on this host")).toBe(true);
  });

  test("a daemon that reports no boot service keeps the setting as it was", () => {
    expect(bootServiceAvailable(config())).toBe(true);
    expect(bootServiceAvailable(null)).toBe(true);
    expect(bringBackDescription(config())).toContain("Installs a boot service");
  });
});
