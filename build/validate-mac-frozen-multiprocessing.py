#!/usr/bin/env python3
"""Prove a frozen Mac backend diverts multiprocessing helper invocations."""

import os
import subprocess
import sys
import time


def validate(executable):
    read_fd, write_fd = os.pipe()
    command = [
        executable,
        "-B",
        "-S",
        "-I",
        "-c",
        f"from multiprocessing.resource_tracker import main;main({read_fd})",
    ]
    process = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        pass_fds=(read_fd,),
        text=True,
    )
    os.close(read_fd)

    try:
        # A correctly diverted resource tracker waits for EOF on its tracking
        # pipe. An undiverted backend sees closed stdin, runs the dictation
        # startup path, and exits or emits application events instead.
        time.sleep(0.5)
        if process.poll() is not None:
            stdout, stderr = process.communicate()
            raise RuntimeError(
                "multiprocessing helper exited before its tracking pipe "
                f"closed (exit={process.returncode}, stdout={stdout!r}, "
                f"stderr={stderr!r})"
            )

        os.close(write_fd)
        write_fd = -1
        stdout, stderr = process.communicate(timeout=10)
    finally:
        if write_fd >= 0:
            os.close(write_fd)
        if process.poll() is None:
            process.kill()
            process.wait()

    if process.returncode != 0:
        raise RuntimeError(
            "diverted resource tracker failed "
            f"(exit={process.returncode}, stdout={stdout!r}, stderr={stderr!r})"
        )
    if stdout or stderr:
        raise RuntimeError(
            "multiprocessing helper produced unexpected application output "
            f"(stdout={stdout!r}, stderr={stderr!r})"
        )


def main():
    if len(sys.argv) != 2:
        raise SystemExit(
            "usage: validate-mac-frozen-multiprocessing.py <frozen-executable>"
        )
    validate(sys.argv[1])
    print("frozen multiprocessing diversion: PASS")


if __name__ == "__main__":
    main()
