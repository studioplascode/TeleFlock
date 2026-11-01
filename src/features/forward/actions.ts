import { core } from "@/core";
import type { ForwardList, ForwardRule } from "@/core/gen";
import { toast } from "@/design";
import { errorHint, errorMessage } from "@/features/shell/errors";

/** `forward.save`; rejects with the core's `invalid_params` (`name: …`) for the editor to map to a field. */
export function saveRule(rule: ForwardRule): Promise<ForwardList> {
  return core.app("forward.save", { rule });
}

/** The quick switch on a rule's card: save it again with `enabled` flipped. */
export function setEnabled(rule: ForwardRule, enabled: boolean): void {
  saveRule({ ...rule, enabled }).catch((err: unknown) => {
    toast({ title: `Couldn't turn ${rule.name} ${enabled ? "on" : "off"}: ${errorMessage(err)}`, description: errorHint(err), status: "error" });
  });
}

/** Delete a rule (its streams end); the toast's Undo saves it again as a new rule. */
export function removeRule(rule: ForwardRule): void {
  core.app("forward.remove", { id: rule.id }).then(
    () =>
      toast({
        title: `Deleted the forward ${rule.name}`,
        duration: 6000,
        action: {
          label: "Undo",
          onClick: () => {
            saveRule({ ...rule, id: "" }).catch((err: unknown) => toast({ title: `Couldn't restore ${rule.name}: ${errorMessage(err)}`, status: "error" }));
          },
        },
      }),
    (err: unknown) => toast({ title: `Couldn't delete ${rule.name}: ${errorMessage(err)}`, description: errorHint(err), status: "error" }),
  );
}

export function stopStream(streamId: string): void {
  core.app("forward.stop", { streamId }).catch((err: unknown) => {
    toast({ title: `Couldn't stop it: ${errorMessage(err)}`, description: errorHint(err), status: "error" });
  });
}
