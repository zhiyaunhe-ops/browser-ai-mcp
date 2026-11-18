#!/usr/bin/env node
// Validate relative Markdown links, GitHub heading anchors and discoverability.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignored = new Set(['.git', 'node_modules', '.venv', 'server/data']);
const localDirectories = new Set(['.workbuddy', 'memory', 'memories', 'references/local']);
// Archive installs have no Git index. The shipped case index is their example list.
const exampleCases = new Set(['README.md']);
const caseIndex = path.join(root, 'references/cases/README.md');
if (fs.existsSync(caseIndex)) for (const link of fs.readFileSync(caseIndex, 'utf8').matchAll(/\]\(([^/\\#?\n)]+\.md)\)/g)) exampleCases.add(link[1]);
function walk(dir = root) {
  return fs.readdirSync(dir, {withFileTypes:true}).flatMap(entry => {
    const abs = path.join(dir, entry.name), rel = path.relative(root, abs).split(path.sep).join('/');
    if (localDirectories.has(rel) || rel === 'MEMORY.md' ||
        rel.startsWith('references/cases/') && !exampleCases.has(rel.slice('references/cases/'.length))) return [];
    if (entry.isDirectory()) return ignored.has(entry.name) || ignored.has(rel) ? [] : walk(abs);
    return entry.isFile() && entry.name.endsWith('.md') ? [rel] : [];
  });
}
function documentFiles() {
  if (!fs.existsSync(path.join(root, '.git'))) return walk();
  // Keep tracked documents even if an ignore rule matches them; skip only local files.
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.md'],
    { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return [...new Set(output.split('\0').filter(file => file && fs.existsSync(path.join(root, file)) && fs.statSync(path.join(root, file)).isFile()))];
}
function visible(source) {
  let fence = null;
  return source.split(/\r?\n/).map(line => {
    const m = line.match(/^\s{0,3}(\x60{3,}|~{3,})/);
    if (m) {
      const val = m[1];
      if (!fence) fence = [val[0], val.length];
      else if (val[0] === fence[0] && val.length >= fence[1]) fence = null;
      return '';
    }
    return fence ? '' : line.replace(/(\x60+)(.*?)\1/g, '');
  }).join('\n');
}
function slug(text) {
  return text.toLowerCase().replace(/<[^>]+>/g,'')
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc}\s-]/gu,'').trim().replace(/\s/g,'-');
}
function anchors(text) {
  const used = new Map(), result = new Set();
  for (const line of visible(text).split('\n')) {
    const m = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    const key = slug(m[1]), n = used.get(key) || 0;
    used.set(key,n+1); result.add(n ? key+'-'+n : key);
  }
  return result;
}
function links(text) {
  const source=visible(text), found=[];
  for (const m of source.matchAll(/!?\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]+)\)/g)) {
    const raw=m[1].trim();
    found.push([raw.startsWith('<')?raw.slice(1,-1):raw.split(/\s+["']/)[0],source.slice(0,m.index).split('\n').length]);
  }
  for (const m of source.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm))
    found.push([m[1]||m[2],source.slice(0,m.index).split('\n').length]);
  return found;
}
const docs=documentFiles(), set=new Set(docs), sources=new Map(docs.map(p=>[p,fs.readFileSync(path.join(root,p),'utf8')]));
const headings=new Map(docs.map(p=>[p,anchors(sources.get(p))])), edges=new Map(docs.map(p=>[p,new Set()]));
const errors=[];let count=0;
for(const file of docs){
  const source=sources.get(file);
  if(!/^## Related documents\s*$/m.test(visible(source))) errors.push(file+': missing Related documents heading');
  for(const [link,line] of links(source)){
    if(/^(?:[a-z][\w+.-]*:|\/\/)/i.test(link)) continue;
    count++;
    let decoded;try{decoded=decodeURIComponent(link)}catch{errors.push(file+':'+line+': invalid URI '+link);continue}
    const [local,hash]=decoded.split('#',2);
    const localPath=local.split('?')[0];
    const dest=localPath ? path.resolve(root,path.dirname(file),localPath) : path.join(root,file);
    const rel=path.relative(root,dest).split(path.sep).join('/');
    if(rel.startsWith('..')||path.isAbsolute(rel)){errors.push(file+':'+line+': escapes repository '+link);continue}
    if(!fs.existsSync(dest)){errors.push(file+':'+line+': missing file '+link);continue}
    const target=fs.statSync(dest).isDirectory()?path.posix.join(rel,'README.md'):rel;
    if(set.has(target))edges.get(file).add(target);
    if(hash && set.has(target) && !headings.get(target).has(hash))errors.push(file+':'+line+': missing anchor #'+hash+' in '+target);
  }
}
const reached=new Set(),queue=set.has('README.md')?['README.md']:[];
while(queue.length){
  const next=queue.shift();if(reached.has(next))continue;
  reached.add(next);for(const linked of edges.get(next)||[])if(!reached.has(linked))queue.push(linked);
}
for(const file of docs)if(!reached.has(file))errors.push(file+': orphan doc not reachable from README.md');
if(errors.length){for(const e of errors)console.error('ERROR '+e);console.error('Documentation check failed: '+errors.length+' issue(s)');process.exitCode=1}
else console.log('Documentation check OK: '+docs.length+' Markdown files, '+count+' local links');
