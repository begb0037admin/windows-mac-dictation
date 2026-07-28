"""Tests for build/validate-lock.py against FINAL_BRIEF.md SS8.1's grammar.
Uses committed fixtures (build/tests/fixtures/locks/) covering every
rejected-grammar example the brief names, plus the real generated lock
files this run produced with pip-compile --generate-hashes --allow-unsafe."""

import importlib.util
import sys
from pathlib import Path

import pytest

BUILD_DIR = Path(__file__).resolve().parent.parent
FIXTURES = BUILD_DIR / "tests" / "fixtures" / "locks"

spec = importlib.util.spec_from_file_location("validate_lock", BUILD_DIR / "validate-lock.py")
validate_lock = importlib.util.module_from_spec(spec)
sys.modules["validate_lock"] = validate_lock
spec.loader.exec_module(validate_lock)


REJECTED_FIXTURES = [
    "1_range.txt",       # package>=1.2
    "2_bare.txt",         # package
    "3_url.txt",          # package @ https://...
    "4_requirement_flag.txt",  # -r other.txt
    "5_constraint_flag.txt",   # --constraint other.txt
    "6_no_hash.txt",      # package==1.2.3 with no hash
    "7_continuation_eof.txt",  # continuation ending at EOF
]


@pytest.mark.parametrize("fixture", REJECTED_FIXTURES)
def test_rejects_every_named_bad_grammar(fixture):
    with pytest.raises(SystemExit) as exc_info:
        validate_lock.validate_lock_file(str(FIXTURES / fixture))
    assert exc_info.value.code == 4


def test_accepts_valid_fixture():
    records = validate_lock.validate_lock_file(str(FIXTURES / "8_valid.txt"))
    assert len(records) == 1
    assert records[0]["name"] == "package"
    assert records[0]["version"] == "1.2.3"


def test_missing_file_exits_3():
    with pytest.raises(SystemExit) as exc_info:
        validate_lock.validate_lock_file(str(FIXTURES / "does_not_exist.txt"))
    assert exc_info.value.code == 3


def test_accepts_generated_option_line():
    records = validate_lock.validate_lock_text(
        "--index-url https://pypi.org/simple\n"
        "package==1.0.0 --hash=sha256:1111111111111111111111111111111111111111111111111111111111111111\n",
        "<inline>",
    )
    assert len(records) == 1


def test_rejects_disallowed_option_line():
    with pytest.raises(validate_lock.LockError):
        validate_lock.validate_lock_text(
            "--constraint other.txt\n"
            "package==1.0.0 --hash=sha256:1111111111111111111111111111111111111111111111111111111111111111\n",
            "<inline>",
        )


def test_rejects_non_sha256_hash_algorithm():
    with pytest.raises(validate_lock.LockError):
        validate_lock.validate_lock_text(
            "package==1.0.0 --hash=md5:1111111111111111111111111111111111111111111111111111111111111111\n",
            "<inline>",
        )


def test_accepts_environment_marker_containing_whitespace():
    text = (
        'package==1.2.3 ; python_version >= "3.11" and sys_platform == "win32" \\\n'
        "    --hash=sha256:1111111111111111111111111111111111111111111111111111111111111111\n"
    )
    records = validate_lock.validate_lock_text(text, "<inline>")
    assert len(records) == 1
    assert records[0]["name"] == "package"


def test_rejects_sha256_digest_with_wrong_length():
    with pytest.raises(validate_lock.LockError):
        validate_lock.validate_lock_text("package==1.0 --hash=sha256:1234\n", "<inline>")


def test_permits_multiline_continuation_with_multiple_hashes():
    text = (
        "package==1.2.3 \\\n"
        "    --hash=sha256:1111111111111111111111111111111111111111111111111111111111111111 \\\n"
        "    --hash=sha256:2222222222222222222222222222222222222222222222222222222222222222\n"
        "    # via other-package\n"
    )
    records = validate_lock.validate_lock_text(text, "<inline>")
    assert len(records) == 1
    assert len(records[0]["hashes"]) == 2


# Real, live-generated locks (pip-compile --generate-hashes --allow-unsafe),
# not synthetic fixtures - proves the parser handles actual tool output,
# not just what we imagine it produces.
@pytest.mark.parametrize("lockfile", ["win-x64.txt", "build-tools.win-x64.txt"])
def test_validates_the_real_generated_locks(lockfile):
    path = BUILD_DIR / "lock" / lockfile
    if not path.exists():
        pytest.skip(f"{lockfile} not generated in this environment")
    records = validate_lock.validate_lock_file(str(path))
    assert len(records) > 0
