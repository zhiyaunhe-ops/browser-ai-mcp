"""从本地 operations JSON 生成可放入 PR 的证据计数。"""
import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path


def summarize(rows):
    groups = defaultdict(Counter)
    for row in rows:
        evidence = row["evidence"]
        counts = groups[row["source"]]
        counts["rows"] += 1
        if evidence.get("result"):
            counts["result"] += 1
        elif evidence.get("state"):
            counts["state_only"] += 1
        else:
            counts["neither"] += 1

    print("| 来源 | 记录 | 有调用返回引用 | 仅有状态引用 | 两项引用均缺 |")
    print("|---|---:|---:|---:|---:|")
    for source, counts in sorted(groups.items()):
        print(f"| {source} | {counts['rows']} | {counts['result']} | "
              f"{counts['state_only']} | {counts['neither']} |")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    args = parser.parse_args()
    with args.bundle.open(encoding="utf-8") as stream:
        summarize(json.load(stream)["rows"])
