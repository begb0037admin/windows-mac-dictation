"""macOS-only entry point for the PyInstaller-frozen backend.

PyInstaller's multiprocessing override must run before importing the real
application.  MLX can create a POSIX resource-tracker process; without this
guard, that child re-enters main.py and starts another complete hotkey/audio
pipeline.  Keep this wrapper Mac-specific so the established Windows package
continues to use main.py directly.
"""

import multiprocessing


def run():
    multiprocessing.freeze_support()

    # Import only after freeze_support has had the opportunity to divert and
    # terminate a multiprocessing worker/resource-tracker invocation.
    from main import main

    main()


if __name__ == "__main__":
    run()
