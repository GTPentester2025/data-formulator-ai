"""Tests for MAX_IMPORT_ROWS hard cap in data loaders."""
from __future__ import annotations

import pytest

from data_formulator.data_loader.external_data_loader import MAX_IMPORT_ROWS


pytestmark = [pytest.mark.backend]


def test_max_import_rows_constant_value() -> None:
    assert MAX_IMPORT_ROWS == 2_000_000


class TestMaxImportRowsCap:
    """Verify the size-capping pattern used by all loaders."""

    def test_size_over_limit_is_capped(self) -> None:
        opts = {"size": 5_000_000}
        size = min(opts.get("size", MAX_IMPORT_ROWS), MAX_IMPORT_ROWS)
        assert size == MAX_IMPORT_ROWS

    def test_size_under_limit_is_preserved(self) -> None:
        opts = {"size": 100_000}
        size = min(opts.get("size", MAX_IMPORT_ROWS), MAX_IMPORT_ROWS)
        assert size == 100_000

    def test_no_size_defaults_to_max(self) -> None:
        opts = {}
        size = min(opts.get("size", MAX_IMPORT_ROWS), MAX_IMPORT_ROWS)
        assert size == MAX_IMPORT_ROWS

    def test_size_exactly_at_limit(self) -> None:
        opts = {"size": MAX_IMPORT_ROWS}
        size = min(opts.get("size", MAX_IMPORT_ROWS), MAX_IMPORT_ROWS)
        assert size == MAX_IMPORT_ROWS

    def test_size_negative_treated_as_given(self) -> None:
        opts = {"size": -1}
        size = min(opts.get("size", MAX_IMPORT_ROWS), MAX_IMPORT_ROWS)
        assert size == -1  # loader-specific logic handles negative values


