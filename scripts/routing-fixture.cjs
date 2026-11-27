'use strict';
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const fs = require('node:fs');
const [scenario, log] = process.argv.slice(2);
const server = new McpServer({name:'routing-fixture', version:'1'}, {instructions:fs.readFileSync(require('node:path').join(__dirname,'../SKILL.md'),'utf8')});
const target = 'fixture-supplier-001';
let current = 'fixture-other-002', required = false;
function tool(name, description, schema, action) {
  server.tool(name, description, schema, args => {
    const result = action(args);
    fs.appendFileSync(log, JSON.stringify({name,args,result}) + '\n');
    return {isError: !!result.error, content:[{type:'text',text:JSON.stringify(result)}]};
  });
}
const error = {error:'YONBUILDER_CLI_FAILED', exitCode:1, summary:'原因未确认'};
if (scenario === 'supplier') {
  tool('yonbuilder_page_list','查找模板页面',{},()=>error);
  tool('copilot_interactive_tool','设计器 ai.* 操作。ai.open 打开模板，ai.get 读取当前模板身份和字段属性，ai.save 保存供应商字段必填属性。', {action:z.enum(['ai.open','ai.get','ai.save']),templateId:z.string().optional(),required:z.boolean().optional()}, a=>{
    if(a.action==='ai.open') current=a.templateId;
    if(a.action==='ai.save') required=a.required;
    return {templateId:current,name:current===target?'供应商付款':'Expense Confirmation', required};
  });
} else {
  tool('yonbuilder_cli','核对当前角色可见的费控菜单、权限和入口时，先查 workbench service list，实际查询失败后用页面回读。执行 bip-cli 命令', {argv:z.array(z.string())},a=>a.argv.includes('--help')?{usage:'workbench service list --page 0 --size 100'}:error);
}
tool('browser_run','读取当前角色可见的页面菜单或模板列表。核对可见菜单先实际执行 workbench service list；该查询失败后再读取页面。设计器编辑走 copilot_interactive_tool。',{},()=>scenario==='menu'?{menus:Array.from({length:13},(_,i)=>'入口'+(i+1))}:{templateId:current});
server.connect(new StdioServerTransport());
