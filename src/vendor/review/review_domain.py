"""Product-edition scope for reusable review knowledge."""
import re


ASP_EXPENSE_EDITION = "超级版和旗舰版"
# The original assessment predates edition tagging. Its scoped ASP expense
# configuration and source receipts were independently identified.
HISTORICAL_DOMAINS = {"7d732627-a871-43e6-a706-56de49635276": ASP_EXPENSE_EDITION}
EXPENSE_TERMS = ("费控", "报销", "报账", "出差申请", "通用申请单", "还款单", "预提单", "借款单",
                 "费用申请", "费用项目", "费用管理", "费用标准", "差旅申请", "expense", "reimbursement")
ASP_TEMPLATE_TOOLS = ("asp_ui_template_update_field", "asp_workbench_query_templates")
ENVIRONMENT = re.compile(r"(?<![a-z0-9])(?:uat|prod(?:uction)?|test|staging|dev)(?![a-z0-9])|生产环境|测试环境|开发环境|预生产|沙箱环境", re.I)


def resolve_domain(data):
    tag = data.get("domain_tag")
    if tag is not None:
        if not isinstance(tag, str) or not tag.strip():
            raise ValueError("domain_tag must be a nonempty product or knowledge domain")
        tag = tag.strip()
    goal = str(data.get("goal") or "").lower()
    tool = data.get("business_tool")
    path = data.get("document_path") or []
    context = " ".join([goal, str(data.get("node_name") or ""), str(data.get("document_name") or ""),
                        *[str(part) for part in path]])
    asp = (data.get("asp_project") is True or bool(re.search(r"(?<![a-z0-9])asp(?![a-z0-9])", goal))
           or tool in (*ASP_TEMPLATE_TOOLS, "asp_workbench_open_node"))
    default_expense_template = tool in ASP_TEMPLATE_TOOLS and not data.get("document_name") and not path
    known = HISTORICAL_DOMAINS.get(data.get("review_id"))
    if known or tool == "asp_workbench_query_general_applications" or default_expense_template or (
            asp and any(term in context for term in EXPENSE_TERMS)):
        if tag and tag not in (ASP_EXPENSE_EDITION, "超级版", "旗舰版", "超级版/旗舰版", "旗舰版/超级版"):
            raise ValueError(f"ASP 费控的产品版本标签是「{ASP_EXPENSE_EDITION}」")
        return ASP_EXPENSE_EDITION
    if tag and (tag in ("测试", "生产", "开发") or ENVIRONMENT.fullmatch(tag) or
                (("版" in tag or "用友" in context or "yonbip" in context or asp) and ENVIRONMENT.search(tag))):
        raise ValueError("用友的 domain_tag 使用产品版本；环境请记录在运行证据中")
    return tag
