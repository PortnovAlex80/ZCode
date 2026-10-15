"""Focused tests of template preservation and refusal, without Word or user data."""

import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from xml.dom import minidom
from zipfile import ZIP_DEFLATED, ZipFile


spec = importlib.util.spec_from_file_location("build_title_docx", Path(__file__).with_name("build_title_docx.py"))
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)


def synthetic_docx() -> bytes:
    parts = {
        "[Content_Types].xml": b'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        "_rels/.rels": b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
        "word/document.xml": (f'<w:document xmlns:w="{renderer.WORD}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" mc:Ignorable="w14"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>OLD </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>TITLE</w:t></w:r></w:p><w:p><w:r><w:t>Author text retained</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11910" w:h="16840"/></w:sectPr></w:body></w:document>').encode(),
        "word/styles.xml": f'<w:styles xmlns:w="{renderer.WORD}"><w:style w:styleId="Original"/></w:styles>'.encode(),
        "word/footer1.xml": f'<w:ftr xmlns:w="{renderer.WORD}"><w:p><w:r><w:t>2025</w:t></w:r></w:p></w:ftr>'.encode(),
        "word/media/image1.bin": bytes(range(256)),
    }
    stream = io.BytesIO()
    with ZipFile(stream, "w", ZIP_DEFLATED) as package:
        package.comment = b"Original package"
        for name, content in parts.items():
            package.writestr(name, content)
    return stream.getvalue()


class TitleTemplateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="title-docx-test-")
        self.root = Path(self.temporary.name)
        self.source = synthetic_docx()
        (self.root / "template.docx").write_bytes(self.source)
        self.request = {"version": 1, "template": "template.docx",
                        "templateSha256": hashlib.sha256(self.source).hexdigest(),
                        "output": "out/title.docx",
                        "replacements": [{"find": "OLD TITLE", "replace": "NEW TITLE", "expectedOccurrences": 1}],
                        "requiredText": ["NEW TITLE", "Author text retained"],
                        "sourceNote": "Synthetic training fixture"}

    def tearDown(self):
        self.temporary.cleanup()

    def run_request(self):
        (self.root / "request.json").write_text(json.dumps(self.request), encoding="utf-8")
        return renderer.build("request.json", self.root)

    def test_split_run_replacement_preserves_package_styles_media_layout_and_namespaces(self):
        receipt = self.run_request()
        self.assertEqual(receipt["status"], "created")
        with ZipFile(io.BytesIO(self.source)) as original, ZipFile(self.root / "out/title.docx") as output:
            self.assertEqual(output.namelist(), original.namelist())
            self.assertEqual(output.comment, original.comment)
            for name in output.namelist():
                if name != "word/document.xml":
                    self.assertEqual(output.read(name), original.read(name))
            xml = output.read("word/document.xml")
            self.assertIn(b"NEW TITLE", xml)
            self.assertNotIn(b"OLD ", xml)
            self.assertIn(b'xmlns:w14=', xml)
            self.assertIn(b'mc:Ignorable="w14"', xml)
            document = minidom.parseString(xml)
            self.assertEqual(len(document.getElementsByTagNameNS(renderer.WORD, "b")), 1)
            self.assertEqual(len(document.getElementsByTagNameNS(renderer.WORD, "i")), 1)
            self.assertEqual(document.getElementsByTagNameNS(renderer.WORD, "pgSz")[0].getAttribute("w:h"), "16840")
            self.assertIsNone(output.testzip())
        self.assertNotIn("Synthetic", json.dumps(receipt))

    def test_unchanged_request_reuses_output_and_receipt_without_writes(self):
        first = self.run_request()
        output = self.root / "out/title.docx"
        receipt = self.root / "out/title.docx.receipt.json"
        before = (output.stat().st_mtime_ns, receipt.read_bytes(), receipt.stat().st_mtime_ns)
        second = self.run_request()
        self.assertEqual(second, {**first, "status": "reused"})
        self.assertEqual(before, (output.stat().st_mtime_ns, receipt.read_bytes(), receipt.stat().st_mtime_ns))

    def test_no_replacements_is_an_exact_docx_copy(self):
        self.request.pop("replacements")
        self.request["requiredText"] = ["OLD TITLE", "2025"]
        self.run_request()
        self.assertEqual((self.root / "out/title.docx").read_bytes(), self.source)

    def test_cyrillic_replacement_is_preserved_and_invalid_xml_characters_refuse(self):
        self.request["replacements"][0]["replace"] = "Расчет опоры ОДН"
        self.request["requiredText"] = ["Расчет опоры ОДН"]
        self.run_request()
        with ZipFile(self.root / "out/title.docx") as output:
            self.assertIn("Расчет опоры ОДН", output.read("word/document.xml").decode("utf-8"))
        self.request["output"] = "out/bad.docx"
        self.request["replacements"][0]["replace"] = "Invalid\x01XML"
        with self.assertRaisesRegex(ValueError, "text"):
            self.run_request()
        self.assertFalse((self.root / "out/bad.docx").exists())

    def test_hash_count_required_text_and_invalid_zip_fail_before_output(self):
        original = json.loads(json.dumps(self.request))
        for changes in [{"templateSha256": "0" * 64},
                        {"replacements": [{"find": "OLD TITLE", "replace": "NEW", "expectedOccurrences": 2}]},
                        {"replacements": [{"find": "MISSING", "replace": "NEW", "expectedOccurrences": 1}]},
                        {"requiredText": ["MISSING"]}]:
            self.request = {**original, **changes}
            with self.assertRaises(ValueError):
                self.run_request()
            self.assertFalse((self.root / "out").exists())
        broken = b"not docx"
        (self.root / "template.docx").write_bytes(broken)
        self.request = {**original, "templateSha256": renderer.digest(broken)}
        with self.assertRaisesRegex(ValueError, "DOCX"):
            self.run_request()
        self.assertFalse((self.root / "out").exists())

    def test_authored_output_or_receipt_change_is_never_overwritten(self):
        self.run_request()
        output = self.root / "out/title.docx"
        output.write_bytes(b"Author changed this file")
        with self.assertRaisesRegex(ValueError, "changed"):
            self.run_request()
        self.assertEqual(output.read_bytes(), b"Author changed this file")
        output.write_bytes(renderer.render_template(self.source, self.request))
        self.request["sourceNote"] = "Different provenance"
        with self.assertRaisesRegex(ValueError, "changed"):
            self.run_request()

    def test_existing_output_without_receipt_and_orphan_receipt_refuse(self):
        (self.root / "out").mkdir()
        output = self.root / "out/title.docx"
        output.write_bytes(b"Authored")
        with self.assertRaisesRegex(ValueError, "receipt"):
            self.run_request()
        self.assertEqual(output.read_bytes(), b"Authored")
        output.unlink()
        (self.root / "out/title.docx.receipt.json").write_text("{}")
        with self.assertRaises(ValueError):
            self.run_request()
        self.assertFalse(output.exists())

    def test_outside_paths_absolute_paths_and_source_output_alias_refuse(self):
        original = json.loads(json.dumps(self.request))
        for changes in [{"output": "../outside.docx"}, {"template": "../outside.docx"},
                        {"output": str(self.root / "absolute.docx")}, {"output": "template.docx"},
                        {"output": "title.md"}]:
            self.request = {**original, **changes}
            with self.assertRaises(ValueError):
                self.run_request()
            self.assertEqual((self.root / "template.docx").read_bytes(), self.source)

    def test_multiple_occurrences_in_one_run_and_nested_paragraphs_are_not_double_counted(self):
        xml = f'<w:document xmlns:w="{renderer.WORD}"><w:body><w:p><w:r><w:t>OLD OLD</w:t></w:r><w:r><w:drawing><w:txbxContent><w:p><w:r><w:t>OLD</w:t></w:r></w:p></w:txbxContent></w:drawing></w:r></w:p></w:body></w:document>'.encode()
        stream = io.BytesIO()
        with ZipFile(io.BytesIO(self.source)) as source, ZipFile(stream, "w") as target:
            for part in source.infolist():
                target.writestr(part, xml if part.filename == "word/document.xml" else source.read(part))
        self.request["replacements"] = [{"find": "OLD", "replace": "LONGER NEW", "expectedOccurrences": 3}]
        self.request["requiredText"] = ["LONGER NEW LONGER NEW"]
        result = renderer.render_template(stream.getvalue(), self.request)
        with ZipFile(io.BytesIO(result)) as output:
            self.assertEqual(output.read("word/document.xml").count(b"LONGER NEW"), 3)


if __name__ == "__main__":
    unittest.main()
