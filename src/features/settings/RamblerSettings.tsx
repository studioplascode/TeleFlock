import { SegmentedControl, Switch } from "@/design";
import { type RamblerRole, usePrefs } from "@/core";
import { Term } from "@/features/shell/Term";
import { Row } from "./parts";

const ROLES: { value: RamblerRole; label: string; note: string }[] = [
  { value: "tiny", label: "Tiny", note: "fastest, the default" },
  { value: "smol", label: "Smol", note: "a little slower, a little smarter" },
  { value: "default", label: "Default", note: "your main model: the most careful, the slowest" },
];

/**
 * Rambler's rows for Settings → Dictation: the switch (off by default) and the omp model role that rewrites the
 * dictation. Rows only; the section around them belongs to the Dictation settings.
 */
export function RamblerRows() {
  const { rambler, ramblerRole, setRambler, setRamblerRole } = usePrefs();
  const note = ROLES.find((r) => r.value === ramblerRole)?.note;
  return (
    <>
      <Row
        label="Rambler: turn rambling into a prompt"
        description="While you dictate, a model on the host rewrites everything you said into one clear prompt: no filler, no false starts, corrections applied, your language. It shows live above the box; when you stop it fills the box, with “Use raw transcript” and Undo. Your words go to that host's omp and its model provider."
      >
        <Switch checked={rambler} onCheckedChange={setRambler} label="Rambler" />
      </Row>
      <Row
        label="Rambler model"
        wide
        description={
          <>
            Which of omp's <Term id="tinyModel">model roles</Term> rewrites it (set per host in omp): {note}. A role the host does not have falls back to smol, then to the raw words.
          </>
        }
      >
        <SegmentedControl<RamblerRole>
          size="sm"
          value={ramblerRole}
          onValueChange={setRamblerRole}
          aria-label="Rambler model"
          options={ROLES.map((r) => ({ value: r.value, label: r.label, disabled: !rambler }))}
        />
      </Row>
    </>
  );
}
