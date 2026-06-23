# Errors

Command failures and integration errors.

---

## [ERR-20260616-001] understand-anything merge script Python version

**Logged**: 2026-06-16T00:00:00+08:00
**Priority**: medium
**Status**: pending
**Area**: tooling

### Summary
Understand-Anything merge script failed under system python3 3.9 because it uses Python 3.10 union type syntax.

### Error
```
TypeError: unsupported operand type(s) for |: types.GenericAlias and NoneType
```

### Context
- Command: python3 .../merge-batch-graphs.py /Users/lucy/Desktop/project/Aigc-platform
- Environment: /usr/bin/python3 Python 3.9.6

### Suggested Fix
Run the script with Python 3.10+ or use a bundled newer Python runtime.

### Metadata
- Reproducible: yes
- Related Files: /Users/lucy/.understand-anything/repo/understand-anything-plugin/skills/understand/merge-batch-graphs.py

---
