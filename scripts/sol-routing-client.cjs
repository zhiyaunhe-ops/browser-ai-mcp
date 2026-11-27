const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const path=require('node:path'), fs=require('node:fs'), os=require('node:os');
const readline=require('node:readline/promises');
async function main(){
  const [scenario,round]=process.argv.slice(2);
  if(!['menu','supplier'].includes(scenario)||!/^\d+$/.test(round)) throw Error('expected scenario and round');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sol-low-'+round+'-'+scenario+'-'));
  const log=path.join(dir,'calls.jsonl');
  const client=new Client({name:'routing-eval',version:'1'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(__dirname,'routing-fixture.cjs'),scenario,log]}));
  console.log(JSON.stringify({log,instructions:client.getInstructions(),tools:(await client.listTools()).tools}));
  const lines=readline.createInterface({input:process.stdin,terminal:false});
  try{
    for await(const line of lines){
      if(line.trim()==='done')break;
      try{const {name,args}=JSON.parse(line); console.log(JSON.stringify(await client.callTool({name,arguments:args})));}catch(e){console.log(JSON.stringify({error:e.message}));}
    }
  }finally{await client.close();lines.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
