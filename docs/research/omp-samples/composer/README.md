# omp composer captures

Raw `herdr pane read <pane> --source detection --lines 12` output from omp 18.13.1 under herdr 0.9.5 (2026-10-27), byte for byte. `crates/tf-hostd/src/inject.rs` (`composer_captures`) parses every file here and asserts the expected result.

File names are `<composer.shape>-<symbolPreset>-<cols>x<rows>-<state>.txt`:

- `box-nerd-*`: the user's own config (`composer.shape: box`, `symbolPreset: nerd`), started the way TeleFlock starts agents (`herdr agent start … --kind omp -- --model openai-codex/gpt-6-luna --thinking low`). The exception is `box-nerd-57x38-plain-omp-idle`, where `omp` was typed into a shell pane.
- All other shapes and presets ran from a fresh `PI_CODING_AGENT_DIR` holding only `setupVersion`, `composer.shape` and `symbolPreset`. It had no credentials, so those panes have no model.
- `status-row`: an extension status (`ui.setStatus`, here a lab copy of the bridge's dim `⇄ teleflock`) draws a row under the composer.
- `swcursor`: `showHardwareCursor: false`. `imesafe`: `tui.imeSafeCursor: true`.
- Dialogs over shapes without a model (`approval`, `ask`, `hook-selector`, `widget-below`) were opened by a lab extension through `ctx.ui.approve` / `askDialog` / `select` / `setWidget`.
- `nolocale`: the herdr server ran with `LANG`, `LC_ALL` and `LC_CTYPE` unset, so panes reported `LC_CTYPE="POSIX"`. The output is byte-identical to the same state under C.UTF-8: omp picks glyphs from `symbolPreset`, not from the locale.
- Exceptions to the pane-size rule:
  - `box-nerd-120x40-idle-retry-hint` was captured after a split. A headless herdr does not resize existing panes, so the size is still 120x40.
  - `*-39x24`, `*-59x24` and `*-120x24` panes were created after changing `[server] headless_cols/headless_rows`.
