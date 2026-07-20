const r = await fetch('http://localhost:3323/api/discover/start', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tags:[{label:'厚涂'}], platforms:['mihuashi'] }) });
const j = await r.json(); console.log('start:', JSON.stringify(j));
for (let i=0;i<25;i++){ await new Promise(r=>setTimeout(r,7000)); const t=await (await fetch(`http://localhost:3323/api/discover/task/${j.sessionId}`)).json(); if(t.status!=='running'){console.log('task:', t.status, 'results:', t.resultCount, 'recalled:', t.stats?.recalled);break;} }
process.exit(0);
