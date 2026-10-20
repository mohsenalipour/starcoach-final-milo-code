# Python Bench

Inspect pyproject.toml, requirements and tests. Preserve the environment selected by the user; never install packages without a visible approved command. Prefer standard-library unittest for small dependency-free projects. The harness resolves a project's .venv first. Python must be installed independently. Read the actual failure output before changing code. Add boundary tests for new behavior, preserve unrelated tests, and call verify after the final edit.
