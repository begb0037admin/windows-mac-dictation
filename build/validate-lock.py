"""
Validates a pip-compile --generate-hashes generated lock file against the
exact grammar in FINAL_BRIEF.md (push2talk-packaging run, SS8.1). Rejects
anything that isn't a fully pinned, fully hashed requirement.

Usage: python validate-lock.py <path-to-lock.txt> [<path> ...]
Exit codes: 0 = all valid; 3 = a given path does not exist; 4 = malformed
or unpinned content found (see stderr for path/line-range/reason).
"""

import re
import sys

ALLOWED_OPTIONS = {
    "--index-url": True,
    "--extra-index-url": True,
    "--trusted-host": True,
    "--find-links": True,
    "--only-binary": True,
    "--no-index": False,
    "--prefer-binary": False,
}

# name[extras]==version[; marker] - normalized package name per PEP 503
# (letters/digits/./-/_ , case-insensitive), extras in [...], exactly one
# ==<nonempty-version> pin, optional environment marker after a ';'.
REQUIREMENT_RE = re.compile(
    r"^(?P<name>[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)"
    r"(?P<extras>\[[A-Za-z0-9][A-Za-z0-9,_-]*\])?"
    r"==(?P<version>[^\s;=<>!~]+)"
    r"(?:\s*;\s*(?P<marker>.+))?$"
)
HASH_RE = re.compile(r"^--hash=(?P<algo>[a-zA-Z0-9]+):(?P<digest>[0-9a-fA-F]+)$")
REJECTED_PIN_OPERATORS = (">=", "<=", "~=", "!=", ">", "<", "@")
ALLOWED_HASH_ALGO = "sha256"


class LockError(Exception):
    def __init__(self, path, start_line, end_line, reason):
        self.path = path
        self.start_line = start_line
        self.end_line = end_line
        self.reason = reason
        super().__init__(f"{path}:{start_line}-{end_line}: {reason}")


def _join_logical_lines(text, path):
    """Yields (joined_text, start_line, end_line) for each logical line,
    joining physical lines connected by an unescaped trailing backslash.
    1-indexed line numbers."""
    # A conventional trailing newline is not itself an extra physical line;
    # strip exactly one so a backslash on the file's true last content line
    # is correctly detected as "continuation ending at EOF" rather than
    # spuriously joining to an artifact empty line from the split.
    if text.endswith("\n"):
        text = text[:-1]
    physical = text.split("\n")
    i = 0
    n = len(physical)
    while i < n:
        start = i + 1
        parts = [physical[i].rstrip("\r")]
        # A trailing " \" (whitespace then backslash) continues to the next
        # physical line; the backslash itself is not part of the content.
        while parts[-1].endswith("\\") and not parts[-1].endswith("\\\\"):
            parts[-1] = parts[-1][:-1].rstrip()
            i += 1
            if i >= n:
                raise LockError(path, start, start + len(parts) - 1, "continuation ending at EOF")
            parts.append(physical[i].rstrip("\r"))
        joined = " ".join(p.strip() for p in parts if p.strip() != "" or len(parts) == 1)
        end = i + 1
        i += 1
        yield joined, start, end


def _strip_inline_comment(line):
    """Strip a trailing ' #...' comment only when the '#' is preceded by
    whitespace and not inside a token (hash digests/URLs in this grammar
    never legitimately contain a literal '#')."""
    idx = line.find(" #")
    if idx == -1:
        return line
    return line[:idx].rstrip()


def _validate_option_line(line, path, start, end):
    token = line.split(None, 1)[0]
    if token not in ALLOWED_OPTIONS:
        raise LockError(path, start, end, f"unrecognized or disallowed option {token!r}")
    needs_value = ALLOWED_OPTIONS[token]
    rest = line[len(token):].strip()
    if needs_value and not rest:
        raise LockError(path, start, end, f"{token} requires a value")
    if not needs_value and rest:
        raise LockError(path, start, end, f"{token} takes no value, got {rest!r}")


def _validate_requirement_line(line, path, start, end):
    tokens = line.split()
    if not tokens:
        return None
    head = tokens[0]
    for op in REJECTED_PIN_OPERATORS:
        if op in head and "==" not in head.split(op)[0] + op:
            pass  # exact rejection handled by the regex failing to match below
    if head in ("-r", "--requirement", "-c", "--constraint") or tokens[0] in ("-e", "--editable"):
        raise LockError(path, start, end, f"disallowed requirement-file directive {head!r}")

    # A bare/unpinned/URL/local-path/editable/VCS requirement will simply fail
    # this regex - every rejected form in FINAL_BRIEF.md SS8.1's examples
    # (">=", bare name, "@ url", editable, VCS) lacks a literal "==<version>"
    # immediately after the name[extras], which the regex requires.
    match = REQUIREMENT_RE.match(head)
    if not match:
        raise LockError(path, start, end, f"not a valid pinned requirement: {head!r}")

    hash_tokens = tokens[1:]
    if not hash_tokens:
        raise LockError(path, start, end, f"{head}: no --hash= tokens (unpinned by hash)")

    digests = []
    for h in hash_tokens:
        hm = HASH_RE.match(h)
        if not hm:
            raise LockError(path, start, end, f"{head}: unrecognized token {h!r} (expected --hash=<algo>:<hex>)")
        if hm.group("algo") != ALLOWED_HASH_ALGO:
            raise LockError(
                path, start, end,
                f"{head}: hash algorithm {hm.group('algo')!r} not in the allowlist ({ALLOWED_HASH_ALGO})",
            )
        digest = hm.group("digest")
        if not digest:
            raise LockError(path, start, end, f"{head}: empty hash digest")
        digests.append(digest)

    return {"name": match.group("name"), "version": match.group("version"), "hashes": digests}


def validate_lock_text(text, path):
    """Returns the list of validated requirement records, or raises LockError."""
    records = []
    for joined, start, end in _join_logical_lines(text, path):
        stripped = joined.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            continue
        stripped = _strip_inline_comment(stripped)
        if not stripped:
            continue
        if stripped.startswith("--") or stripped.startswith("-r") or stripped.startswith("-c") or stripped.startswith("-e"):
            first_token = stripped.split(None, 1)[0]
            if first_token in ("-r", "-c", "-e"):
                raise LockError(path, start, end, f"disallowed requirement-file directive {first_token!r}")
            _validate_option_line(stripped, path, start, end)
            continue
        record = _validate_requirement_line(stripped, path, start, end)
        if record:
            records.append(record)

    if not records:
        raise LockError(path, 1, 1, "no valid pinned+hashed requirement records found in file")
    return records


def validate_lock_file(path):
    try:
        with open(path, "r", encoding="utf-8", newline=None) as f:
            text = f.read()
    except FileNotFoundError:
        print(f"MISSING_LOCK: {path} does not exist. Generate it with: "
              f"pip-compile --generate-hashes --allow-unsafe --output-file={path} <matching .in file>",
              file=sys.stderr)
        sys.exit(3)
    except UnicodeDecodeError as exc:
        print(f"MALFORMED_LOCK: {path}: not valid UTF-8: {exc}", file=sys.stderr)
        sys.exit(4)

    try:
        records = validate_lock_text(text, path)
    except LockError as exc:
        print(f"MALFORMED_LOCK: {exc}", file=sys.stderr)
        sys.exit(4)

    return records


def main(argv):
    if not argv:
        print("usage: python validate-lock.py <path-to-lock.txt> [<path> ...]", file=sys.stderr)
        sys.exit(3)
    for path in argv:
        records = validate_lock_file(path)
        print(f"OK: {path}: {len(records)} pinned+hashed requirement(s) validated")
    sys.exit(0)


if __name__ == "__main__":
    main(sys.argv[1:])
