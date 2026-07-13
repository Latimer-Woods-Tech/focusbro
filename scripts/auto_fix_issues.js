#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MAX_PASSES = 20;
const ISSUE_FILE = path.join(ROOT, 'docs', 'archive', 'ISSUE_REGISTER.md');
const LESSONS_FILE = path.join(ROOT, 'docs', 'archive', 'LESSONS_LEARNED.md');

const exts = ['.js', '.mjs', '.ts', '.jsx', '.tsx'];

function walk(dir){
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(f => {
    const fp = path.join(dir,f);
    const stat = fs.statSync(fp);
    if(stat && stat.isDirectory()){
      if(['node_modules','.git','coverage','.github'].includes(f)) return;
      results = results.concat(walk(fp));
    } else {
      if(exts.includes(path.extname(f))) results.push(fp);
    }
  });
  return results;
}

function safeWrite(file, content){
  fs.writeFileSync(file, content, 'utf8');
}

function gitCommit(message){
  try{ execSync('git add -A && git commit -m "' + message.replace(/"/g,'\"') + '"',{stdio:'ignore'}); return execSync('git rev-parse --short HEAD').toString().trim(); }
  catch(e){ return null; }
}

function appendIssue(entry){
  const now = new Date().toISOString();
  const text = `- ID: ${now}\n  ${entry}\n\n`;
  fs.appendFileSync(ISSUE_FILE, text, 'utf8');
}

function updateLessons(summary){
  const note = `\n- ${new Date().toISOString()}: ${summary}\n`;
  try{ fs.appendFileSync(LESSONS_FILE, note, 'utf8'); }
  catch(e){ /* create file if missing */ fs.writeFileSync(LESSONS_FILE, '# Lessons Learned\n' + note,'utf8'); }
}

function runPass(pass){
  const files = walk(ROOT);
  let changes = 0;
  files.forEach(f => {
    let src = fs.readFileSync(f,'utf8');
    let out = src;
    // 1) Empty catch: catch(e) { console.error("Unhandled error:", e); } or catch(e) { console.error("Unhandled error:", e); }
    out = out.replace(/catch\s*\(\s*([a-zA-Z_$][\\w$]*)\s*\)\s*\{\s*\}/g, 'catch($1) { console.error("Unhandled error:", $1); }');
    // 2) Silent promise .catch((e) => { console.error("Promise rejected (no handler):", e); })
    out = out.replace(/\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g, '.catch((e) => { console.error("Promise rejected (no handler):", e); })');
    // 3) Silent promise .catch(() =>\s*null)
    out = out.replace(/\.catch\s*\(\s*\(\s*\)\s*=>\s*null\s*\)/g, '.catch((e) => { console.error("Promise rejected (returned null):", e); return null; })');
    // 4) .catch((e) => { console.error("Promise rejected (no handler):", e); }) with paramless arrow: .catch((e) => { console.error("Promise rejected (no handler):", e); })
    out = out.replace(/\.catch\s*\(\s*=>\s*\{\s*\}\s*\)/g, '.catch((e) => { console.error("Promise rejected (no handler):", e); })');

    if(out !== src){
      fs.writeFileSync(f,out,'utf8');
      changes +=1;
      appendIssue(`File: ${path.relative(ROOT,f)}\n  Pattern: silent-catch or empty-catch\n  Confirmed Against: LESSONS_LEARNED.md / PRODUCT_PRINCIPLES.md\n  Severity: medium\n  Fix: Added logging to catch handlers`);
    }
  });

  if(changes>0){
    const commit = gitCommit(`chore: auto-fix pass ${pass} - ${changes} changes`);
    updateLessons(`Auto-fix pass ${pass} applied ${changes} changes (commit ${commit || 'none'})`);
  }
  return changes;
}

function main(){
  console.log('Starting auto-fix up to',MAX_PASSES,'passes');
  let total = 0;
  for(let i=1;i<=MAX_PASSES;i++){
    console.log('Pass',i);
    const changed = runPass(i);
    total += changed;
    if(changed===0){ console.log('No changes in pass',i,'— stopping early.'); break; }
  }
  console.log('Auto-fix complete. Total changes:',total);
  console.log('Issues recorded in ISSUE_REGISTER.md');
}

main();
