---
name: browser-ai
description: 用 YonBuilder 查询业务元数据和数据库结构，用 browser-ai MCP 执行浏览器任务并回读业务结果。
---

# Browser AI

## 查询与配置

- 查应用、业务对象和页面时，指定目标租户与环境，按应用 → 业务对象 → 页面定位。查模板字段用 `yonbuilder_field_get`，预览属性变更用 `yonbuilder_field_preview`，按容器修改并回读用 `yonbuilder_field_set`。
- 查业务实体时，已知完整业务对象编码就调用 `metadata find --biz-obj-code`。只有业务名称时，先用 `erm find --type md.metadata.mdBizObj --keywords <业务名称>`，按应用和业务含义选取完整编码。
- 查当前角色的菜单用 `workbench service list`。查物理表、列、主键和索引用 `yonbuilder_cli` 的 `schema` 入口。建单或配置时，按业务动作选择平台命令，保存后回读目标记录。
- 任务涉及页面交互时，使用已获授权的浏览器通道。编辑设计器时，按目标模板 ID 定位，执行页面提供的原生动作，再从同一模板读取已保存的值。

## 页面操作与验收

1. 用 `run_begin` 登记目标、URL 和可独立读取的验收条件。有原始会话标识时填入 `sessionSource`。
2. 查看返回的流程与适用条件。匹配的流程可把 `invoke.script` 直接传给 `browser_run`。自定义脚本按当前 ego-browser 的 Page 与 TaskSpace API 编写。
3. 在同一 run 中按顺序执行，用 `run_get` 查看该轮的 `executionId`。定位用友控件时，按页面、表格行和字段缩小范围。核对业务请求时，用 `evidence_query` 读取该轮的 API 记录。
4. 保存后，在单独的 `observe` 轮次重新打开目标记录并读取实际值。写入结果未明时先查原执行和记录现状，再决定下一步。
5. 用 `run_finish` 提交各验收条件的观察引用。匹配填 `succeeded`，确认不符填 `failed`，部分完成或仍待核验时填 `unknown`。用 `partialHandoff.reason` 区分业务未完成（`business_incomplete`）、操作已完成但缺目标回读（`missing_readback`）、现有回读与预设断言不相容（`criteria_mismatch`）。若业务仍有待办，优先选业务未完成。在 `remaining` 写明具体缺口，已回读的步骤列入 `observedSteps`，每项附本 run 的 `observationId`。

遇到 `EGO_PROGRAM_CONTRACT`、`INVALID_ARGUMENT` 或 `INVALID_RESOLUTION` 时，先读取返回的问题位置、参数要求和相关执行信息，按当前安装的 API 修正调用，再继续操作；不要原样重试或放宽契约。若执行是否生效仍未知，先查询原执行和记录现状，不重放写入。错误消失不能替代业务回读。

`run_finish` 验证被拒绝时，核对返回的 `readbacks`、原执行和已有观察，确认引用属于本 run、位于最后一次写入之后，并支持对应验收条件。缺少回读或结果未明时保留 `unknown` 和具体交接缺口，不通过修改验收条件消除拒绝。评审材料应保留各次结束请求的 outcome、verification 和返回记录位置，说明最终结论依据；结束调用被接受只表示工具接受了交接。

## Related documents

- [浏览器工具、字段操作与批量验收](references/browser-workflows.md)
- [交接后的独立评审](skills/browser-ai-review/SKILL.md)
- [安装](install.md) · [项目说明](README.md)
