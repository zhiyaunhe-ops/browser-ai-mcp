"""Run YonCode with a fresh home and workspace per sample. Keep fixture traces for replay."""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PROMPTS = {
    "supplier": "把供应商付款模板 fixture-supplier-001 的供应商字段改为必填，保存并独立回读。当前打开的是 Expense Confirmation。",
    "menu": "核对当前角色实际可见的费控菜单，看看是否只有 13 个入口。",
}

def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

def sample(item):
    case, index = item
    directory = base / f"{case}-{index}"
    home, project = directory / "home" / ".yoncode", directory / "project"
    home.mkdir(parents=True)
    project.mkdir()
    trace = directory / "calls.jsonl"
    tools = ["yonbuilder_cli", "browser_run"] if case == "menu" else ["yonbuilder_page_list", "copilot_interactive_tool", "browser_run"]
    write(home / "mcp.json", {"mcpServers":{"routing":{"command":shutil.which("node"), "args":[str(ROOT/"scripts/routing-fixture.cjs"), case, str(trace)]}}})
    allow = ["tool_search"] + ["mcp__routing__"+name for name in tools]
    write(home / "settings.json", {"permissions":{"allow":allow}})
    env = dict(os.environ, YONCODE_HOME=str(home.parent), YONCODE_CONFIG=str(config))
    args = [str(cli), "--headless", "--print", "--permission-mode=ASK", "--max-turns=16",
            "--append-system-prompt-file="+str(ROOT/"SKILL.md"),
            "--prompt=使用当前模拟租户的 routing MCP 执行业务任务。"+PROMPTS[case]]
    with (directory/"agent.log").open("wb") as out:
        proc = subprocess.run(args, cwd=project, env=env, stdout=out, stderr=subprocess.STDOUT, timeout=240)
    startup = (home/"logs/agent.log").read_text("utf8",errors="replace")
    discovered = re.findall(r"MCP client '([^']+)' connected, (\d+) tools discovered", startup)
    if discovered != [("routing", str(len(tools)))]:
        raise RuntimeError(f"Unexpected MCP inventory: {discovered}")
    log = (directory/"agent.log").read_text(encoding="utf8", errors="replace")
    actual = re.findall(r"^\[tool\] (\S+)", log, re.M)
    foreign = sorted(set(actual)-set(allow))
    calls = [json.loads(line) for line in trace.read_text("utf8").splitlines()] if trace.exists() else []
    print(case,index,"exit",proc.returncode,"unexpected",foreign,"calls",[x["name"] for x in calls],flush=True)
    return proc.returncode == 0 and not foreign and bool(calls)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--rounds",type=int,default=3)
    n=parser.parse_args().rounds
    base=Path(tempfile.mkdtemp(prefix="yoncode-isolated-"))
    config=Path(os.environ.get("YONCODE_EVAL_MODEL_CONFIG", Path.home()/".yoncode/config.json"))
    cli=Path(os.environ["LOCALAPPDATA"])/"Programs/Yoncode/yoncode-cli.exe"
    print(base,flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        valid=list(pool.map(sample, [(case,i) for i in range(1,n+1) for case in PROMPTS]))
    for i in range(1,n+1):
        grader=subprocess.run(["pwsh","-File",str(ROOT/"scripts/eval-yoncode-routing.ps1"),
            "-SupplierTrace",str(base/f"supplier-{i}/calls.jsonl"),"-MenuTrace",str(base/f"menu-{i}/calls.jsonl")])
        valid.append(grader.returncode==0)
    raise SystemExit(0 if all(valid) else 1)
