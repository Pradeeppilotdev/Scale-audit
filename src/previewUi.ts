/** Browser script embedded in the local preview. Kept separate for behavioral tests. */
export const PREVIEW_SCRIPT = String.raw`
const f=document.getElementById('f'),out=document.getElementById('out');
const button=f.querySelector('button');
let busy=false;
async function requestJson(url,options={}) {
  const response=await fetch(url,{...options,signal:AbortSignal.timeout(10000)});
  const body=await response.json();
  if(!response.ok) throw new Error(body.error||('HTTP '+response.status));
  return body;
}
f.addEventListener('submit',async(e)=>{
  e.preventDefault();
  if(busy) return;
  busy=true;button.disabled=true;
  out.style.display='block';out.textContent='queued...';
  try {
    const repo=document.getElementById('repo').value;
    const job=await requestJson('/api/audit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({repo})});
    if(!job.id) throw new Error(job.error||'Invalid audit response');
    const deadline=Date.now()+300000;
    while(Date.now()<deadline) {
      await new Promise(resolve=>setTimeout(resolve,1500));
      if(Date.now()>=deadline) break;
      const state=await requestJson('/api/jobs/'+encodeURIComponent(job.id));
      if(!['queued','running','done','error'].includes(state.status)) throw new Error('Invalid job response');
      out.textContent='status: '+state.status;
      if(state.status==='done') {location.href='/report/'+encodeURIComponent(job.id);return;}
      if(state.status==='error') throw new Error(state.error||'Audit failed');
    }
    throw new Error('Stopped waiting after 5 minutes. Please try again.');
  } catch(error) {
    out.textContent='error: '+(error instanceof Error?error.message:String(error));
  } finally {
    busy=false;button.disabled=false;
  }
});
`;
