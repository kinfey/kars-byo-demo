import os
import shutil
import stat
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

MAX_FILES = 500
MAX_EXPANDED_BYTES = 50 * 1024 * 1024
IGNORED_ROOT_ENTRIES = {"__MACOSX", ".DS_Store"}


def fail(message):
    raise ValueError(message)


archive = Path(sys.argv[1])
target = Path(sys.argv[2])
skill_name = sys.argv[3]
target.parent.mkdir(parents=True, exist_ok=True)

with zipfile.ZipFile(archive) as source:
    entries = source.infolist()
    if not entries or len(entries) > MAX_FILES:
        fail("Skill ZIP must contain 1-500 entries")
    if sum(item.file_size for item in entries) > MAX_EXPANDED_BYTES:
        fail("Expanded Skill ZIP exceeds 50 MiB")
    for item in entries:
        name = item.filename
        parts = PurePosixPath(name).parts
        mode = item.external_attr >> 16
        if (
            not name
            or "\x00" in name
            or "\\" in name
            or name.startswith("/")
            or any(part in ("", ".", "..") for part in parts)
            or stat.S_ISLNK(mode)
            or item.flag_bits & 0x1
        ):
            fail("Skill ZIP contains an unsafe path, symlink, or encrypted entry")

    temporary = Path(tempfile.mkdtemp(prefix=f".{target.name}-", dir=target.parent))
    try:
        source.extractall(temporary)
        root = temporary
        if not (root / "SKILL.md").is_file():
            children = [
                child for child in temporary.iterdir()
                if child.name not in IGNORED_ROOT_ENTRIES
            ]
            if len(children) == 1 and children[0].is_dir() and (children[0] / "SKILL.md").is_file():
                root = children[0]
        if not (root / "SKILL.md").is_file():
            fail("Skill ZIP must contain SKILL.md at its root")
        skill_file = root / "SKILL.md"
        content = skill_file.read_text(encoding="utf-8")
        if content.startswith("---\n") and "\n---" in content[4:]:
            end = content.index("\n---", 4)
            frontmatter = content[4:end].splitlines()
            replaced = False
            for index, line in enumerate(frontmatter):
                if line.startswith("name:"):
                    frontmatter[index] = f"name: {skill_name}"
                    replaced = True
                    break
            if not replaced:
                frontmatter.insert(0, f"name: {skill_name}")
            content = "---\n" + "\n".join(frontmatter) + content[end:]
        else:
            content = f"---\nname: {skill_name}\ndescription: Uploaded Skill {skill_name}\n---\n\n" + content
        skill_file.write_text(content, encoding="utf-8")
        replacement = target.with_name(f".{target.name}.ready")
        shutil.rmtree(replacement, ignore_errors=True)
        os.replace(root, replacement)
        shutil.rmtree(target, ignore_errors=True)
        os.replace(replacement, target)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)
