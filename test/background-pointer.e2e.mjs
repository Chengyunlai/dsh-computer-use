/** Opt-in real background pointer check using only an owned, non-activating AppKit fixture. */
import {DesktopDriver} from '../drivers/desktop.js';

import {spawn,execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
if (process.platform !== 'darwin') throw new Error('This opt-in check requires macOS');
const root=await mkdtemp(join(tmpdir(),'dsh-background-pointer-')) + '/';
const fixtures=new URL('./fixtures/',import.meta.url).pathname;
const bundle=root+'Fixture.app';
await mkdir(bundle+'/Contents/MacOS',{recursive:true});
await writeFile(bundle+'/Contents/Info.plist',`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.dsh.fixture.${randomUUID()}</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleName</key><string>DSH background fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`);
try {
 execFileSync('xcrun',['swiftc','-O',fixtures+'background-pointer.swift','-o',bundle+'/Contents/MacOS/fixture']);
 execFileSync('xcrun',['swiftc','-O',fixtures+'desktop-observer.swift','-o',root+'observe']);
} catch (error) { await rm(root,{recursive:true,force:true}); throw error; }
const observe=()=>JSON.parse(execFileSync(root+'observe',{encoding:'utf8'}))[0];
const baseline=observe();
const p=spawn('/usr/bin/open',['-g','-n','-W',bundle,'--args',root+'count.txt']);
let fixturePid;
p.stderr.on('data',chunk=>process.stderr.write(chunk));
const d=new DesktopDriver();
try {
 const started=Date.now();
 while(!fixturePid){
  try{fixturePid=Number(await readFile(root+'count.txt.pid','utf8'))}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!fixturePid){if(Date.now()-started>5000||p.exitCode!==null)throw new Error('Fixture failed to start');await new Promise(r=>setTimeout(r,100));}
 }
 d.targetPid=fixturePid;d.targetName='Fixture';
 let shot;
 const deadline=Date.now()+5000;
 while(!shot){
  try{shot=await d.screenshot()}catch(error){
   if(error.code!=='WINDOW_NOT_FOUND'||Date.now()>=deadline||p.exitCode!==null)throw error;
   await new Promise(r=>setTimeout(r,100));
  }
 }
 await writeFile(root+'fixture-before.png',shot.bytes);
 const state=await d.getState();const button=state.elements.find(x=>x.text==='Probe');assert.ok(button,JSON.stringify(state));
 d.lastElements=[];
 const x=button.box.x+button.box.width/2,y=button.box.y+button.box.height/2;
 const before=observe();assert.notEqual(before.pid,fixturePid);
 const report={baseline,before,pid:fixturePid,capture:d.capture,point:{x,y}};
 const saved=d.capture;
 d.capture={...saved,bounds:{...saved.bounds,X:saved.bounds.X+1}};
 await assert.rejects(d.click(x,y),{code:'STALE_WINDOW'});
 d.capture=saved;
 await assert.rejects(d.click(-2,-2),{code:'STALE_WINDOW'});
 assert.equal((await readFile(root+'count.txt','utf8')).trim(),'0');
 report.result=await d.click(x,y);
 await new Promise(r=>setTimeout(r,500));
 report.count=(await readFile(root+'count.txt','utf8')).trim();report.after=observe();
 await writeFile(root+'fixture-report.json',JSON.stringify(report,null,2));
 console.log(report);
 assert.equal(report.count,'1');assert.equal(report.after.pid,before.pid);
 assert.equal(report.after.x,before.x);assert.equal(report.after.y,before.y);
 const after=await d.screenshot();await writeFile(root+'fixture-after.png',after.bytes);

} finally {
 await d.close();
 const exited=p.exitCode===null?once(p,'exit'):Promise.resolve();
 if(fixturePid){try{process.kill(fixturePid)}catch(error){if(error.code!=='ESRCH')throw error;}}
 else p.kill();
 await exited;
 execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',['-u',bundle]);
 await rm(root,{recursive:true,force:true});
}
