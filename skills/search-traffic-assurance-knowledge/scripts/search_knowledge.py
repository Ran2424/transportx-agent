#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
import mimetypes
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

import yaml


DEFAULT_ROOT = Path(__file__).resolve().parent.parent / "references" / "knowledge"
CLASS_ALIASES = {
    "法律": "LEGAL_GOVERNANCE",
    "法规": "LEGAL_GOVERNANCE",
    "制度": "LEGAL_GOVERNANCE",
    "标准": "STANDARD_SPEC",
    "规范": "STANDARD_SPEC",
    "预案": "PLAN_PROCEDURE",
    "规程": "PLAN_PROCEDURE",
    "案例": "CASE_PRACTICE",
    "经验": "CASE_PRACTICE",
    "方法": "METHOD_RESEARCH",
    "研究": "METHOD_RESEARCH",
    "项目": "PROJECT_DATA",
    "数据": "PROJECT_DATA",
}
CLASS_PRIORITY = {
    "LEGAL_GOVERNANCE": 6,
    "STANDARD_SPEC": 5,
    "PLAN_PROCEDURE": 4,
    "PROJECT_DATA": 3,
    "CASE_PRACTICE": 2,
    "METHOD_RESEARCH": 1,
}


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def emit(value: Any, as_json: bool) -> None:
    if as_json:
        print(json.dumps(value, ensure_ascii=False, indent=2))
        return
    if isinstance(value, str):
        print(value)
        return
    print(json.dumps(value, ensure_ascii=False, indent=2))


def normalized(text: str) -> str:
    return re.sub(r"[\W_]+", "", text, flags=re.UNICODE).lower()


def tokens(text: str) -> list[str]:
    output: list[str] = []
    for part in re.findall(r"[A-Za-z0-9][A-Za-z0-9./+-]*|[\u3400-\u9fff]+", text.lower()):
        if re.fullmatch(r"[\u3400-\u9fff]+", part):
            if len(part) <= 4:
                output.append(part)
            output.extend(part[index : index + 2] for index in range(len(part) - 1))
            output.extend(part[index : index + 3] for index in range(len(part) - 2))
        else:
            output.append(part)
    return output


def resolve_classes(values: list[str] | None) -> set[str]:
    return {
        CLASS_ALIASES.get(value, value)
        for value in (values or [])
    }


class KnowledgeBase:
    def __init__(self, root: Path, include_all_status: bool = False) -> None:
        self.root = root
        catalog = root / "_catalog" / "documents.jsonl"
        if not catalog.exists():
            raise SystemExit(f"Knowledge catalog not found: {catalog}")
        documents = load_jsonl(catalog)
        self.documents = {
            row["doc_id"]: row
            for row in documents
            if include_all_status or row.get("validation_status") == "accepted"
        }
        if not self.documents:
            raise SystemExit("No eligible knowledge documents found")

    def doc_path(self, doc_id: str) -> Path:
        document = self.documents.get(doc_id)
        if not document:
            raise SystemExit(f"Unknown or ineligible doc_id: {doc_id}")
        return self.root / document["path"]

    def metadata(self, doc_id: str) -> dict[str, Any]:
        path = self.doc_path(doc_id) / "document.yaml"
        return yaml.safe_load(path.read_text(encoding="utf-8"))

    def iter_knowledge(self, doc_ids: Iterable[str] | None = None):
        selected = doc_ids or self.documents.keys()
        for doc_id in selected:
            document = self.documents[doc_id]
            path = self.root / document["path"] / "data" / "knowledge.jsonl"
            for item in load_jsonl(path):
                yield document, item

    def node(self, node_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        doc_id = node_id.split("@", 1)[0]
        document = self.documents.get(doc_id)
        if not document:
            raise SystemExit(f"Unknown or ineligible node: {node_id}")
        nodes = load_jsonl(self.doc_path(doc_id) / "data" / "nodes.jsonl")
        node = next((row for row in nodes if row["node_id"] == node_id), None)
        if not node:
            raise SystemExit(f"Node not found: {node_id}")
        return document, node

    def knowledge_item(
        self, knowledge_id: str
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        match = re.match(r"^K-(.+)-\d{6}$", knowledge_id)
        candidates = (
            [match.group(1)]
            if match and match.group(1) in self.documents
            else self.documents.keys()
        )
        for document, item in self.iter_knowledge(candidates):
            if item["knowledge_id"] == knowledge_id:
                return document, item
        raise SystemExit(f"Knowledge item not found: {knowledge_id}")


def matches_filters(
    document: dict[str, Any], item: dict[str, Any], args: argparse.Namespace
) -> bool:
    classes = resolve_classes(args.classes)
    if classes and document["document_class"] not in classes:
        return False
    if args.doc_ids and item["doc_id"] not in set(args.doc_ids):
        return False
    checks = (
        (args.tags, set(item.get("topics", []))),
        (args.stages, set(item.get("applicable_stages", []))),
        (args.scenarios, set(item.get("scenarios", []))),
        (args.actors, set(item.get("actors", []))),
        (args.knowledge_types, {item.get("knowledge_type")}),
        (args.forces, {item.get("normative_force")}),
    )
    return all(not wanted or set(wanted) & actual for wanted, actual in checks)


def source_locator(
    root: Path,
    document: dict[str, Any],
    item: dict[str, Any],
) -> list[dict[str, Any]]:
    target = root / document["path"]
    metadata = yaml.safe_load((target / "document.yaml").read_text(encoding="utf-8"))
    output = []
    for ref in item.get("source_refs", []):
        locator = dict(ref)
        source_file = ref.get("source_file") or metadata["source_file"]
        source_path = target / source_file
        locator["source_path"] = str(source_path)
        if ref.get("pdf_page"):
            locator["source_link"] = f"{source_path}#page={ref['pdf_page']}"
        output.append(locator)
    return output


def citation_for(
    root: Path,
    document: dict[str, Any],
    item: dict[str, Any],
) -> list[str]:
    target = root / document["path"]
    nodes = {
        row["node_id"]: row
        for row in load_jsonl(target / "data" / "nodes.jsonl")
    }
    citations = []
    for ref in item.get("source_refs", []):
        node = nodes.get(ref["node_id"], {})
        clause = node.get("number") or node.get("title") or node.get("locator")
        if ref.get("pdf_page"):
            printed = (
                f"（正文第{ref['printed_page']}页）"
                if ref.get("printed_page")
                else ""
            )
            citations.append(
                f"《{document['title']}》{clause}，"
                f"PDF第{ref['pdf_page']}页{printed}。"
            )
        else:
            unit = ref.get("source_unit", "来源单元未知")
            line_text = (
                f"，第{ref['line_start']}—{ref['line_end']}行"
                if ref.get("line_start") and ref.get("line_end")
                else ""
            )
            citations.append(
                f"《{document['title']}》{clause}，{unit}{line_text}。"
            )
    return citations


def add_common_filters(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--class", dest="classes", action="append")
    parser.add_argument("--doc-id", dest="doc_ids", action="append")
    parser.add_argument("--tag", dest="tags", action="append")
    parser.add_argument("--stage", dest="stages", action="append")
    parser.add_argument("--scenario", dest="scenarios", action="append")
    parser.add_argument("--actor", dest="actors", action="append")
    parser.add_argument("--knowledge-type", dest="knowledge_types", action="append")
    parser.add_argument("--force", dest="forces", action="append")


def add_runtime_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--knowledge-root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--all-status", action="store_true")


def command_stats(kb: KnowledgeBase, args: argparse.Namespace) -> None:
    classes = Counter(row["document_class"] for row in kb.documents.values())
    knowledge = sum(row.get("knowledge_count", 0) for row in kb.documents.values())
    nodes = sum(
        len(load_jsonl(kb.doc_path(doc_id) / "data" / "nodes.jsonl"))
        for doc_id in kb.documents
    )
    emit(
        {
            "knowledge_root": str(kb.root),
            "eligible_documents": len(kb.documents),
            "nodes": nodes,
            "knowledge_items": knowledge,
            "classes": dict(classes),
        },
        args.json,
    )


def command_documents(kb: KnowledgeBase, args: argparse.Namespace) -> None:
    classes = resolve_classes(args.classes)
    rows = []
    for document in kb.documents.values():
        if classes and document["document_class"] not in classes:
            continue
        if args.doc_ids and document["doc_id"] not in set(args.doc_ids):
            continue
        if args.tags:
            searchable = normalized(document["title"] + " " + document["document_class"])
            if not any(normalized(tag) in searchable for tag in args.tags):
                knowledge_tags = set()
                for _, item in kb.iter_knowledge([document["doc_id"]]):
                    knowledge_tags.update(item.get("topics", []))
                    knowledge_tags.update(item.get("applicable_stages", []))
                    knowledge_tags.update(item.get("scenarios", []))
                if not set(args.tags) & knowledge_tags:
                    continue
        rows.append(document)
    rows.sort(
        key=lambda row: (
            -CLASS_PRIORITY.get(row["document_class"], 0),
            row["doc_id"],
        )
    )
    if args.json:
        emit(rows, True)
        return
    for row in rows:
        print(
            f"{row['doc_id']} | {row['document_class']} | {row['title']} | "
            f"{row['knowledge_count']}条 | {row['validation_status']}"
        )


def command_search(kb: KnowledgeBase, args: argparse.Namespace) -> None:
    query_tokens = tokens(args.query)
    if not query_tokens:
        raise SystemExit("Query must contain searchable text")
    corpus = [
        (document, item)
        for document, item in kb.iter_knowledge()
        if matches_filters(document, item, args)
    ]
    if not corpus:
        emit([], args.json)
        return

    frequencies = []
    document_frequency: Counter[str] = Counter()
    for document, item in corpus:
        searchable = " ".join(
            [
                item["statement"],
                document["title"],
                " ".join(item.get("topics", [])),
                " ".join(item.get("applicable_stages", [])),
                " ".join(item.get("scenarios", [])),
                " ".join(item.get("actors", [])),
            ]
        )
        counter = Counter(tokens(searchable))
        frequencies.append((document, item, searchable, counter))
        document_frequency.update(set(counter))

    total = len(frequencies)
    average_length = sum(sum(counter.values()) for *_, counter in frequencies) / total
    query_compact = normalized(args.query)
    scored = []
    for document, item, searchable, counter in frequencies:
        length = sum(counter.values()) or 1
        score = 0.0
        for token in query_tokens:
            frequency = counter.get(token, 0)
            if not frequency:
                continue
            inverse = math.log(
                1 + (total - document_frequency[token] + 0.5)
                / (document_frequency[token] + 0.5)
            )
            score += inverse * (frequency * 2.2) / (
                frequency + 1.2 * (1 - 0.75 + 0.75 * length / average_length)
            )
        statement_compact = normalized(item["statement"])
        if query_compact and query_compact in statement_compact:
            score += 12
        query_parts = [
            normalized(part)
            for part in re.split(r"[\s,，、;；]+", args.query)
            if normalized(part)
        ]
        score += 2.5 * sum(part in statement_compact for part in query_parts)
        score += 0.08 * CLASS_PRIORITY.get(document["document_class"], 0)
        if score > 0:
            scored.append((score, document, item))

    scored.sort(key=lambda row: (-row[0], row[2]["knowledge_id"]))
    results = []
    for score, document, item in scored[: args.limit]:
        results.append(
            {
                "score": round(score, 4),
                "knowledge_id": item["knowledge_id"],
                "doc_id": item["doc_id"],
                "title": document["title"],
                "document_class": document["document_class"],
                "knowledge_type": item["knowledge_type"],
                "normative_force": item["normative_force"],
                "verification_status": item["verification_status"],
                "statement": item["statement"],
                "topics": item.get("topics", []),
                "stages": item.get("applicable_stages", []),
                "scenarios": item.get("scenarios", []),
                "source_refs": source_locator(kb.root, document, item),
                "citations": citation_for(kb.root, document, item),
            }
        )
    if args.json:
        emit(results, True)
        return
    for index, result in enumerate(results, start=1):
        print(
            f"\n[{index}] {result['title']} | {result['knowledge_id']} | "
            f"score={result['score']} | {result['normative_force']}"
        )
        print(result["statement"])
        for citation in result["citations"]:
            print(f"出处：{citation}")
        for ref in result["source_refs"]:
            print(f"原件：{ref['source_link'] if ref.get('source_link') else ref['source_path']}")


def filter_tree(node: dict[str, Any], needle: str) -> dict[str, Any] | None:
    children = [
        child
        for child in (
            filter_tree(value, needle) for value in node.get("children", [])
        )
        if child
    ]
    searchable = normalized(
        " ".join(
            [
                str(node.get("title") or ""),
                str(node.get("summary") or ""),
                " ".join(node.get("tags", [])),
            ]
        )
    )
    if needle in searchable or children:
        copied = dict(node)
        copied["children"] = children
        return copied
    return None


def print_tree(node: dict[str, Any], depth: int, max_depth: int) -> None:
    if depth > max_depth:
        return
    page_span = node.get("page_span")
    pages = (
        f" PDF {page_span[0]}–{page_span[1]}"
        if page_span and page_span[0] != page_span[1]
        else f" PDF {page_span[0]}"
        if page_span
        else ""
    )
    print(
        f"{'  ' * depth}- {node['node_id']} | "
        f"{node.get('title') or node.get('number') or node['node_type']}{pages}"
    )
    for child in node.get("children", []):
        print_tree(child, depth + 1, max_depth)


def command_tree(kb: KnowledgeBase, args: argparse.Namespace) -> None:
    tree = json.loads(
        (kb.doc_path(args.doc_id) / "data" / "tree.json").read_text(encoding="utf-8")
    )
    root = tree["root"]
    if args.contains:
        root = filter_tree(root, normalized(args.contains))
        if not root:
            emit([], args.json)
            return
    if args.json:
        emit({"doc_id": args.doc_id, "root": root}, True)
    else:
        print_tree(root, 0, args.depth)


def command_node(kb: KnowledgeBase, args: argparse.Namespace) -> None:
    document, node = kb.node(args.node_id)
    references = []
    for _, item in kb.iter_knowledge([document["doc_id"]]):
        if any(ref["node_id"] == args.node_id for ref in item["source_refs"]):
            references.append(item["knowledge_id"])
    result = {
        "doc_id": document["doc_id"],
        "title": document["title"],
        "document_class": document["document_class"],
        "node": node,
        "knowledge_ids": references,
    }
    if args.json:
        emit(result, True)
        return
    print(f"{document['title']} | {node['node_id']} | {node['node_type']}")
    print("层级：" + " > ".join(node.get("heading_path", [])))
    print(node.get("normalized_text") or node.get("source_text") or "")
    print("来源：" + json.dumps(node.get("page_refs", []), ensure_ascii=False))
    if references:
        print("知识卡：" + ", ".join(references))


def command_cite(kb: KnowledgeBase, args: argparse.Namespace) -> None:
    document, item = kb.knowledge_item(args.knowledge_id)
    refs = source_locator(kb.root, document, item)
    metadata = kb.metadata(document["doc_id"])
    source_path = kb.doc_path(document["doc_id"]) / metadata["source_file"]
    source_sha256 = metadata.get("source_sha256")
    if not source_sha256:
        source_sha256 = hashlib.sha256(source_path.read_bytes()).hexdigest()
    mime_type = mimetypes.guess_type(source_path.name)[0] or "application/octet-stream"
    source_kind = (
        "pdf" if mime_type == "application/pdf"
        else "image" if mime_type.startswith("image/")
        else "document"
    )
    result = {
        "knowledge_id": item["knowledge_id"],
        "doc_id": document["doc_id"],
        "title": document["title"],
        "statement": item["statement"],
        "document_class": document["document_class"],
        "normative_force": item["normative_force"],
        "verification_status": item["verification_status"],
        "document_status": metadata.get("status"),
        "issuer": metadata.get("issuer"),
        "source": {
            "kind": source_kind,
            "mime_type": mime_type,
            "relative_path": str(source_path.relative_to(kb.root)),
            "sha256": source_sha256,
        },
        "citations": citation_for(kb.root, document, item),
        "source_refs": refs,
    }
    if args.json:
        emit(result, True)
        return
    print(item["statement"])
    print(
        f"属性：{document['document_class']} / {item['normative_force']} / "
        f"{item['verification_status']}"
    )
    for citation in result["citations"]:
        print(f"引用：{citation}")
    for ref in refs:
        print(f"原件：{ref.get('source_link') or ref['source_path']}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Search the major-event traffic-assurance knowledge base"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    stats = subparsers.add_parser("stats")
    add_runtime_options(stats)

    documents = subparsers.add_parser("documents")
    add_runtime_options(documents)
    documents.add_argument("--class", dest="classes", action="append")
    documents.add_argument("--doc-id", dest="doc_ids", action="append")
    documents.add_argument("--tag", dest="tags", action="append")

    search = subparsers.add_parser("search")
    add_runtime_options(search)
    search.add_argument("query")
    search.add_argument("--limit", type=int, default=10)
    add_common_filters(search)

    tree = subparsers.add_parser("tree")
    add_runtime_options(tree)
    tree.add_argument("doc_id")
    tree.add_argument("--depth", type=int, default=4)
    tree.add_argument("--contains")

    node = subparsers.add_parser("node")
    add_runtime_options(node)
    node.add_argument("node_id")

    cite = subparsers.add_parser("cite")
    add_runtime_options(cite)
    cite.add_argument("knowledge_id")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    kb = KnowledgeBase(args.knowledge_root, include_all_status=args.all_status)
    commands = {
        "stats": command_stats,
        "documents": command_documents,
        "search": command_search,
        "tree": command_tree,
        "node": command_node,
        "cite": command_cite,
    }
    commands[args.command](kb, args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
