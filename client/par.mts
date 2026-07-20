// 同时发起两个不同标签的发现搜索，验证并行
const a = await (await fetch('http://localhost:3323/api/discover/start', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tags:[{label:'厚涂'}], platforms:['mihuashi'] }) })).json();
const b = await (await fetch('http://localhost:3323/api/discover/start', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tags:[{label:'日系'}], platforms:['mihuashi'] }) })).json();
console.log('A:', JSON.stringify(a), 'B:', JSON.stringify(b));
for (let i=0;i<25;i++){ await new Promise(r=>setTimeout(r,7000));
  const ta = await (await fetch(`http://localhost:3323/api/discover/task/${a.sessionId}`)).json();
  const tb = await (await fetch(`http://localhost:3323/api/discover/task/${b.sessionId}`)).json();
  console.log(`${i*7}s: A=${ta.status}/${ta.resultCount} B=${tb.status}/${tb.resultCount}`);
  if (ta.status!=='running' && tb.status!=='running') break;
}
process.exit(0);
