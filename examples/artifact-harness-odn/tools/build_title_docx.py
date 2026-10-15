"""Copy an owned DOCX template with explicit, counted text substitutions.

No model, solver, Word automation or network request is executed here. Document
layout is retained from the template; native Word remains the pagination owner.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tempfile
from xml.dom import Node, minidom
from zipfile import BadZipFile, ZipFile


WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
XML = "http://www.w3.org/XML/1998/namespace"
MAX_REQUEST = 1024 * 1024
MAX_PACKAGE = 32 * 1024 * 1024
MAX_UNPACKED = 128 * 1024 * 1024
MAX_XML = 8 * 1024 * 1024


def digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def bounded_text(value: object, label: str, *, nonempty: bool = False) -> str:
    if not isinstance(value, str) or len(value) > 16384 or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]", value):
        raise ValueError(f"Invalid {label} text.")
    if nonempty and not value:
        raise ValueError(f"Empty {label} text.")
    return value


def local_path(root: Path, value: str, *, relative_only: bool = True) -> Path:
    if not isinstance(value, str) or not value or "\0" in value:
        raise ValueError("Invalid project path.")
    raw = Path(value)
    if relative_only and (raw.is_absolute() or re.match(r"^[\\/]|^[A-Za-z]:", value)):
        raise ValueError("Project-relative path required.")
    if ".." in value.replace("\\", "/").split("/"):
        raise ValueError("Parent traversal is not supported.")
    candidate = raw if raw.is_absolute() else root / raw
    resolved = candidate.resolve()
    if not resolved.is_relative_to(root):
        raise ValueError("Path is outside the project root.")
    if candidate.is_symlink():
        raise ValueError("Linked input/output files are not supported.")
    return resolved


def validate_request(request: object) -> dict:
    allowed = {"version", "template", "templateSha256", "output", "replacements", "requiredText", "sourceNote"}
    if not isinstance(request, dict) or set(request) - allowed:
        raise ValueError("Invalid title request fields.")
    if type(request.get("version")) is not int or request["version"] != 1:
        raise ValueError("Title request version 1 required.")
    for name in ("template", "output"):
        bounded_text(request.get(name), name, nonempty=True)
    if not isinstance(request.get("templateSha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", request["templateSha256"]):
        raise ValueError("Exact lowercase template SHA-256 required.")
    replacements = request.get("replacements", [])
    if not isinstance(replacements, list) or len(replacements) > 128:
        raise ValueError("At most 128 replacements are supported.")
    for index, replacement in enumerate(replacements):
        if not isinstance(replacement, dict) or set(replacement) != {"find", "replace", "expectedOccurrences"}:
            raise ValueError(f"Invalid replacement {index} fields.")
        bounded_text(replacement["find"], f"replacement {index} find", nonempty=True)
        bounded_text(replacement["replace"], f"replacement {index} replacement")
        count = replacement["expectedOccurrences"]
        if type(count) is not int or not 1 <= count <= 1000:
            raise ValueError(f"Invalid replacement {index} expected count.")
    required = request.get("requiredText", [])
    if not isinstance(required, list) or len(required) > 128:
        raise ValueError("At most 128 required text checks are supported.")
    for text in required:
        bounded_text(text, "required", nonempty=True)
    if "sourceNote" in request:
        bounded_text(request["sourceNote"], "source note")
    return request


def node_text(node: Node) -> str:
    return "".join(child.data for child in node.childNodes if child.nodeType in (Node.TEXT_NODE, Node.CDATA_SECTION_NODE))


def paragraph_leaves(document: minidom.Document) -> list[list[Node]]:
    result = []
    for paragraph in document.getElementsByTagNameNS(WORD, "p"):
        leaves = []
        for leaf in paragraph.getElementsByTagNameNS(WORD, "t"):
            parent = leaf.parentNode
            while parent is not None and parent is not paragraph:
                if parent.nodeType == Node.ELEMENT_NODE and parent.namespaceURI == WORD and parent.localName == "p":
                    break
                parent = parent.parentNode
            if parent is paragraph:
                leaves.append(leaf)
        result.append(leaves)
    return result


def replace_paragraph(leaves: list[Node], find: str, replacement: str) -> int:
    originals = [node_text(leaf) for leaf in leaves]
    whole = "".join(originals)
    matches = []
    position = 0
    while (position := whole.find(find, position)) >= 0:
        matches.append(position)
        position += len(find)
    for start in reversed(matches):
        end = start + len(find)
        offset = 0
        inserted = False
        for leaf, original in zip(leaves, originals):
            left, right = max(0, start - offset), min(len(original), end - offset)
            offset += len(original)
            if left >= right:
                continue
            current = node_text(leaf)
            value = current[:left] + (replacement if not inserted else "") + current[right:]
            inserted = True
            for child in list(leaf.childNodes):
                leaf.removeChild(child)
            leaf.appendChild(leaf.ownerDocument.createTextNode(value))
            leaf.setAttributeNS(XML, "xml:space", "preserve")
    return len(matches)


def render_template(content: bytes, request: dict) -> bytes:
    try:
        with ZipFile(io.BytesIO(content)) as package:
            parts = package.infolist()
            names = [part.filename for part in parts]
            if len(parts) > 4096 or len(names) != len(set(names)):
                raise ValueError("DOCX has excessive or duplicate parts.")
            if not {"[Content_Types].xml", "_rels/.rels", "word/document.xml"}.issubset(names):
                raise ValueError("A real Word DOCX package is required.")
            if sum(part.file_size for part in parts) > MAX_UNPACKED or any(part.flag_bits & 1 for part in parts):
                raise ValueError("DOCX package is oversized or encrypted.")
            payloads = {part.filename: package.read(part) for part in parts}
            comment = package.comment
    except (BadZipFile, KeyError, RuntimeError) as error:
        raise ValueError("Unreadable DOCX package.") from error
    documents = {}
    for name, payload in payloads.items():
        if name.startswith("word/") and name.endswith(".xml"):
            if len(payload) > MAX_XML or b"<!DOCTYPE" in payload.upper() or b"<!ENTITY" in payload.upper():
                raise ValueError("Unsupported DOCX XML part.")
            try:
                documents[name] = minidom.parseString(payload)
            except Exception as error:
                raise ValueError("Invalid DOCX XML part.") from error
    paragraphs = {name: paragraph_leaves(document) for name, document in documents.items()}
    main = documents["word/document.xml"].documentElement
    if main.namespaceURI != WORD or main.localName != "document" or not main.getElementsByTagNameNS(WORD, "body"):
        raise ValueError("Word document body is missing from the DOCX package.")
    changed = set()
    for index, replacement in enumerate(request.get("replacements", [])):
        count = sum("".join(node_text(leaf) for leaf in leaves).count(replacement["find"])
                    for groups in paragraphs.values() for leaves in groups)
        if count != replacement["expectedOccurrences"]:
            raise ValueError(f"Replacement {index} occurrence count differs: expected {replacement['expectedOccurrences']}, found {count}.")
        for name, groups in paragraphs.items():
            for leaves in groups:
                if replace_paragraph(leaves, replacement["find"], replacement["replace"]):
                    changed.add(name)
    all_text = "\n".join("".join(node_text(leaf) for leaf in leaves)
                         for groups in paragraphs.values() for leaves in groups)
    for index, text in enumerate(request.get("requiredText", [])):
        if text not in all_text:
            raise ValueError(f"Required text check {index} failed.")
    if not changed:
        return content
    for name in changed:
        payloads[name] = documents[name].toxml(encoding="UTF-8")
    stream = io.BytesIO()
    with ZipFile(stream, "w") as result:
        result.comment = comment
        for part in parts:
            result.writestr(part, payloads[part.filename])
    output = stream.getvalue()
    if len(output) > MAX_PACKAGE:
        raise ValueError("Generated DOCX exceeds package limit.")
    return output


def publish_new(path: Path, content: bytes) -> None:
    """Publish a complete same-directory file atomically without overwriting."""
    descriptor, temporary = tempfile.mkstemp(prefix=".title-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def build(request_path: Path | str, root: Path | str) -> dict:
    root = Path(root).resolve(strict=True)
    if not root.is_dir():
        raise ValueError("Project root must be an existing directory.")
    request_path = local_path(root, str(request_path), relative_only=False)
    if request_path.stat().st_size > MAX_REQUEST:
        raise ValueError("Title request exceeds size limit.")
    try:
        request = validate_request(json.loads(request_path.read_text(encoding="utf-8-sig")))
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ValueError("Invalid title request JSON.") from error
    template = local_path(root, request["template"])
    output = local_path(root, request["output"])
    if template.suffix.lower() != ".docx" or output.suffix.lower() != ".docx" or template == output:
        raise ValueError("Distinct DOCX template and output paths required.")
    receipt_path = local_path(root, str(output.relative_to(root)) + ".receipt.json")
    if template.stat().st_size > MAX_PACKAGE:
        raise ValueError("Template exceeds size limit.")
    content = template.read_bytes()
    template_sha = digest(content)
    if template_sha != request["templateSha256"]:
        raise ValueError("Template SHA-256 mismatch.")
    request_sha = digest(json.dumps(request, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    rendered = render_template(content, request)
    receipt = {"version": 1, "output": output.relative_to(root).as_posix(),
               "requestSha256": request_sha, "templateSha256": template_sha,
               "outputSha256": digest(rendered)}
    if output.exists() or receipt_path.exists():
        try:
            if receipt_path.stat().st_size > MAX_REQUEST:
                raise ValueError("Existing receipt exceeds size limit.")
            previous = json.loads(receipt_path.read_text(encoding="utf-8"))
            if previous != receipt or output.stat().st_size > MAX_PACKAGE or digest(output.read_bytes()) != receipt["outputSha256"]:
                raise ValueError("Previously authored output or receipt has changed; choose a new output path.")
        except (OSError, json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ValueError("Existing output lacks its matching intact receipt; choose a new output path.") from error
        return {**receipt, "status": "reused"}
    output.parent.mkdir(parents=True, exist_ok=True)
    # Revalidate resolved parents immediately before publication. Both files are
    # no-clobber; an interrupted pair is refused on the next invocation.
    if local_path(root, request["output"]) != output:
        raise ValueError("Output location changed during preparation.")
    publish_new(output, rendered)
    publish_new(receipt_path, (json.dumps(receipt, indent=2) + "\n").encode("utf-8"))
    return {**receipt, "status": "created"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True)
    parser.add_argument("--root", default=os.getcwd())
    options = parser.parse_args()
    try:
        print(json.dumps(build(options.request, options.root), ensure_ascii=True))
        return 0
    except (OSError, ValueError) as error:
        print(json.dumps({"status": "error", "error": str(error)}, ensure_ascii=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
