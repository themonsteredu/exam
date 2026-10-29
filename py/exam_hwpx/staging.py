"""대용량 시험지 조각 검증과 조립. 네트워크 주소는 입력으로 받지 않는다."""
from __future__ import annotations

import json
import re
from collections.abc import Callable
from uuid import uuid4

PART_BYTES = 4_000_000
MAX_PARTS = 24
MAX_OUTPUT_BYTES = 49_000_000
_PART = re.compile(r"^generated/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([A-Za-z0-9._-]{1,100}\.bin)$")


def validate_parts(value: object) -> tuple[str, list[str]]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_PARTS:
        raise ValueError("저장된 시험지 조각 목록이 올바르지 않습니다")
    doc_id = None
    paths: list[str] = []
    for part in value:
        if not isinstance(part, str) or ".." in part:
            raise ValueError("저장된 시험지 경로가 올바르지 않습니다")
        match = _PART.fullmatch(part)
        if not match or (doc_id is not None and doc_id != match.group(1)) or part in paths:
            raise ValueError("저장된 시험지 경로가 올바르지 않습니다")
        doc_id = match.group(1)
        paths.append(part)
    return doc_id, paths  # type: ignore[return-value]


def read_exam_parts(paths: list[str], read_part: Callable[[str], bytes]) -> dict:
    chunks = []
    total = 0
    for path in paths:
        chunk = read_part(path)
        if not chunk or len(chunk) > PART_BYTES:
            raise ValueError("저장된 시험지 조각의 크기가 올바르지 않습니다")
        total += len(chunk)
        if total > PART_BYTES * MAX_PARTS:
            raise ValueError("저장된 시험지 데이터가 너무 큽니다")
        chunks.append(chunk)
    try:
        exam = json.loads(b"".join(chunks))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("저장된 시험지 데이터를 읽지 못했습니다") from exc
    if not isinstance(exam, dict) or not isinstance(exam.get("sections"), list):
        raise ValueError("저장된 시험지 데이터 모양이 올바르지 않습니다")
    return exam


def output_path(doc_id: str, data: bytes) -> str:
    if not data or len(data) > MAX_OUTPUT_BYTES:
        raise ValueError("완성된 한글 파일이 보관 가능한 크기를 넘었습니다")
    return f"generated/{doc_id}/{uuid4()}.hwpx"
