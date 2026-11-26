#!/usr/bin/env python3
"""Run the previous Hong Kong day's Browser review on the Oracle host."""
from datetime import datetime, timedelta
import json
from pathlib import Path
import subprocess
import sys
from zoneinfo import ZoneInfo


def main():
    day = (datetime.now(ZoneInfo("Asia/Hong_Kong")).date() - timedelta(days=1)).isoformat()
    state = Path.home() / ".local/state/browser-ai-mcp/reviews"
    directory = state / day
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    result = subprocess.run([sys.executable, str(Path(__file__).with_name("browser-review-pr.py")),
                             "run", "--day", day, "--state-dir", str(state)], capture_output=True, text=True)
    if result.returncode:
        print(result.stderr, file=sys.stderr, flush=True)
        message = f"{day} 浏览器 Eval 缺报。Oracle 本地评审或 PR 提交未完成。详情见本机 {directory} 和定时日志。"
        key = f"browser-eval:missing:{day}"
    else:
        receipt = json.loads(result.stdout)
        (directory / "pr.json").write_text(result.stdout)
        message = f"{day} 浏览器 Eval 已在 Oracle 独立评审。GitHub PR 状态为 {receipt['pullRequestState']}。\n{receipt['pullRequest']}"
        report = Path(receipt["report"]).read_text()
        conclusion = next((line.strip() for line in report.splitlines()[1:]
                           if line.strip() and not line.startswith(("#", "|", "`"))), "")
        if conclusion:
            message += "\n" + conclusion[:400]
        key = f"browser-eval:review:{day}"
    notice = directory / ("missing.txt" if result.returncode else "notice.txt")
    notice.write_text(message + "\n")
    notifier = Path.home() / ".local/bin/yonclaw-result"
    subprocess.run([notifier, "notify", "--key", key, "--file", notice], check=True)
    subprocess.run([notifier, "status", "--key", key], check=True)
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
