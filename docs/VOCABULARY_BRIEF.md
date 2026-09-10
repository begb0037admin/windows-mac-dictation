# Personal Vocabulary — feature brief

> Status: **SPEC — approved shape, not yet built.** Kevin asked for this
> 2026-09-10 after "Codex" kept transcribing as "codec". To be built
> **after** the Windows pill rebuild.

## Goal

Deterministically fix specific words/phrases that Whisper consistently
mishears, and have the corrections apply **identically on every machine**
(Windows desktop + Mac) with no per-machine setup.

Explicitly **not** model fine-tuning — training Whisper or LLaMA on Kevin's
speech would need hours of labelled audio, a training pipeline, GPU time
and re-quantising for mlx/ct2, to solve what a word-replacement list solves
in one line.

## The list — `vocabulary.json`, committed to the repo

```json
[
  { "heard": "codec",  "write": "Codex" },
  { "heard": "code x", "write": "Codex" },
  { "heard": "llama",  "write": "LLaMA" }
]
```

- Lives at repo root, bundled into the app at build time (like `config.py`
  / `transcribe.py`), so it is **identical on every machine built from
  `main`** — that is the cross-machine guarantee.
- `heard` matches whole words or whole multi-word phrases, case-insensitive.
- `write` is inserted exactly as written.
- Adding a term = edit this file + commit; it reaches all machines at the
  next build. No per-machine config, no Settings step.
- Trade-off Kevin accepted: `codec` is a real word — opting it in means
  "I always mean Codex."

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
- `vocabulary.json` — the list
- `vocabulary.py` — `load_vocabulary()`, `apply_vocabulary(text, entries)`,
  `whisper_prompt(entries)`
- `test_vocabulary.py`

**Edit**
- `main.py` — load the list at startup; call `apply_vocabulary()` between
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
