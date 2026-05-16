# Pi Configuration

This is the personal Pi coding agent configuration directory (`~/.pi`).

## Preferences

### Tool Usage

- **Prefer `typescript` for ad hoc scripting** and **prefer `bash` for shell-native commands**.
  - Use the `typescript` tool for HTTP requests, JSON parsing, file analysis, structured data extraction, summarization, batch operations, and other tasks that look like a small program rather than a shell command.
  - Use `bash` for shell-native operations such as `ls`, `find`, `rg`, `grep`, piping existing CLI tools, inspecting processes, or running project task runners.
  - Avoid using `bash` mainly as a wrapper to run inline scripts in other languages (for example `python - <<'PY'`, `node -e`, or similar) when `typescript` can handle the task directly.
  - `bash` is still appropriate when shell composition is the natural solution or when an existing external CLI is simpler than writing a script.
