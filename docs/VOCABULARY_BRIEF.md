# Personal Vocabulary — feature brief

> Status: **BUILT 2026-09-10** (commit TBD), pending a build/install to
> each machine + Kevin's live confirmation. Kevin asked for this after
> "Codex" kept transcribing as "codec"; two-file design ("both") approved
> the same day. Implementation matches this brief — see the code in
> `vocabulary.py`, `main.py`, `transcribe.py`, `config.py`, and
> `test_vocabulary.py` (13 cases). Baseline `vocabulary.json` currently
> ships two entries: `codec` / `code x` -> `Codex`.

## Goal

Deterministically fix specific words/phrases that Whisper consistently
mishears, and have the corrections apply **identically on every machine**
(Windows desktop + Mac) with no per-machine setup.

Explicitly **not** model fine-tuning — training Whisper or LLaMA on Kevin's
speech would need hours of labelled audio, a training pipeline, GPU time
and re-quantising for mlx/ct2, to solve what a word-replacement list solves
in one line.

## The list — two files, merged at load (Kevin approved "both", 2026-09-10)

Entry shape (both files):

```json
[
  { "heard": "codec",  "write": "Codex" },
  { "heard": "code x", "write": "Codex" },
  { "heard": "llama",  "write": "LLaMA" }
]
```

- `heard` matches whole words or whole multi-word phrases, case-insensitive.
- `write` is inserted exactly as written.
- Trade-off Kevin accepted: `codec` is a real word — opting it in means
  "I always mean Codex."

**1. `vocabulary.json` at repo root — the shared baseline.**
Bundled into the app at build time (like `config.py` / `transcribe.py`), so
it is identical on every machine built from `main`. Changing it = edit +
commit + rebuild both machines. For terms that should always be everywhere.

**2. `<P2T_CONFIG_DIR>/vocabulary.json` — per-machine, instant, no rebuild.**
Lives in the same writable config dir as the per-machine `config.json`
(`~/Library/Application Support/ptt/` on Mac, `%LOCALAPPDATA%\...\ptt\` on
Windows). Optional — absent by default. Edit it and restart PTT; no build.
An agent writes it on both machines over SSH in one step, so adding a word
stays zero-manual for Kevin *and* instant.

**Merge rule at load:** start from the committed baseline, then apply the
local file on top — a local entry with the same `heard` (case-insensitive)
overrides the baseline's `write`; new local `heard` entries are appended.
`vocabulary.py`'s `load_vocabulary()` owns this merge. A malformed or
missing local file is ignored with a stderr warning, never fatal.

## Pipeline integration

Current: `mic → Whisper (transcribe.py) → Ollama cleanup (cleanup.py) → paste`

1. **Replace pass (the guarantee).** New `vocabulary.py` with
   `apply_vocabulary(text, entries)` — whole-word / whole-phrase,
   case-insensitive replacement on the **raw Whisper text**, run in
   `main.py` **after `transcribe()` and before `cleanup()`**. Deterministic;
   runs before the cleanup LLM so the LLM can't "correct" a fixed proper
   noun and sees cleaner input.
2. **Whisper priming (help, same list).** The `write` terms are joined into
   a short comma-separated string and passed as `initial_prompt` to both
   backends (`faster-whisper` and `mlx-whisper` both accept it), nudging
   Whisper to spell them right in the first place. Kept short — Whisper's
   prompt budget is ~224 tokens; a proper-noun list is tiny.

## Files

**New**
- `vocabulary.json` — the committed baseline list (repo root)
- `vocabulary.py` — `load_vocabulary(baseline_path, local_path)` (reads +
  merges both files), `apply_vocabulary(text, entries)`,
  `whisper_prompt(entries)`
- `test_vocabulary.py`

**Edit**
- `config.py` — resolve `<P2T_CONFIG_DIR>/vocabulary.json` path (mirrors `resolve_config_path()`)
- `main.py` — load + merge both lists at startup; call `apply_vocabulary()` between
  `transcribe()` and `cleanup()`; build + pass the `initial_prompt`
- `transcribe.py` — accept an `initial_prompt` and forward it to
  `model.transcribe(...)` (faster-whisper) and `mlx_whisper.transcribe(...)`
- `build/build-app.ps1` + `build/build-app.sh` + the PyInstaller spec files
  — bundle `vocabulary.json` into the packaged resources
- `ARCHITECTURE.md` (pipeline), `HANDOVER.md`

## Tests (~4 pytest cases)

- `codec` → `Codex`; `Codec` → `Codex` (case-insensitive match)
- `codecs` / `codecx` left untouched (word boundary)
- multi-word phrase key (`code x` → `Codex`)
- empty list / no matches → text unchanged (no-op)
- `whisper_prompt()` builds the expected comma string

## Out of scope for v1 (follow-ups)

- A Settings UI to edit the list without a rebuild
- Feeding the terms into the Ollama cleanup system prompt as well
- Automatic homophone / plural handling — add explicit entries instead

## Risk notes

- `initial_prompt` can occasionally make Whisper echo or over-bias toward
  prompt words. It is the *help* layer only; the deterministic replace pass
  is the guarantee. Verify with real dictation after wiring.
- `heard` keys should be word-ish (letters/digits, spaces between words). A
  key that starts or ends with punctuation (e.g. `c++`) won't match cleanly
  because of the `\b` anchors. None in the baseline; revisit `_pattern_for`
  if such a term is ever needed.
- Replacements are applied longest-key-first and are independent passes, so
  a contrived list where one entry's `write` contains another entry's
  `heard` could chain. Not a concern for a small curated proper-noun list.
