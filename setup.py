"""Shim so `pip install -e .` also works on pre-PEP-660 pip.

All metadata lives in pyproject.toml.
"""

from setuptools import setup

setup()
