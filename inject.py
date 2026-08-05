"""
Step 4 of the MVP: paste cleaned-up text at the cursor via clipboard + a
simulated paste keystroke. Cross-platform: Ctrl+V on Windows, Cmd+V on Mac.

Clipboard-paste is used instead of simulating individual keystrokes because
Teams (and similar Electron/web-based apps) can drop characters or trigger
odd autocomplete behaviour with simulated typing — paste is far more
reliable. See docs/BUILD_BRIEF.md section 6.
"""

import platform
import time

import pyautogui
import pyperclip


def _paste_macos() -> None:
    """Post Command-V with the modifier attached to the V events.

    PyAutoGUI's macOS hotkey implementation posts Command-down and V as
    separate Quartz events. In the packaged app macOS did not carry that
    synthetic modifier state onto the V event, so a literal "v" appeared in
    the target. Setting kCGEventFlagMaskCommand on both V events expresses
    the shortcut atomically in the event metadata macOS actually evaluates.
    """
    from Quartz import (
        CGEventCreateKeyboardEvent,
        CGEventPost,
        CGEventSetFlags,
        kCGEventFlagMaskCommand,
        kCGHIDEventTap,
    )

    # macOS virtual key code 9 is the physical V key used by Command-V.
    for is_key_down in (True, False):
        event = CGEventCreateKeyboardEvent(None, 9, is_key_down)
        CGEventSetFlags(event, kCGEventFlagMaskCommand)
        CGEventPost(kCGHIDEventTap, event)


def _copy_verified(text: str, attempts: int = 3) -> None:
    """Put ``text`` on the clipboard and prove it is readable before paste."""
    for _ in range(attempts):
        pyperclip.copy(text)
        if pyperclip.paste() == text:
            return
        time.sleep(0.05)
    raise RuntimeError("clipboard did not contain the new dictation text")


def inject(text: str) -> None:
    """Copy text to the clipboard and simulate a paste at the cursor.

    macOS intentionally leaves the dictation text on the clipboard. Quartz
    queues the Command-V event for the target application, so restoring the
    previous clipboard immediately after posting the event can race with the
    target and paste stale text. Keeping the new text makes the operation
    deterministic and also gives the user a manual Command-V fallback.
    """
    if not text.strip():
        return

    system = platform.system()
    previous_clipboard = pyperclip.paste() if system != "Darwin" else None
    _copy_verified(text)

    if system == "Darwin":
        _paste_macos()
    else:
        pyautogui.hotkey("ctrl", "v")
        time.sleep(0.05)
        pyperclip.copy(previous_clipboard)
