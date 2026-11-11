/*
 * i want — visual layer (see fx.css). Loaded after app.js; app.js announces the selected app with the
 * `iwant:select` event. Nothing here runs per scroll: the hero part is pure CSS, the drawings and the
 * tilt run only while the artwork is on screen, the tab is shown and motion is ON.
 */
(()=>{'use strict';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const projects=window.IWANT_PROJECTS||[];
// a cross-document transition that the browser skips (e.g. the page was already shown) rejects its
// promises; nothing depends on them
addEventListener('pagereveal',e=>{const vt=e.viewTransition;if(vt){vt.ready.catch(()=>{});vt.finished.catch(()=>{})}});
const reduced=matchMedia('(prefers-reduced-motion:reduce)'),hover=matchMedia('(hover:hover) and (pointer:fine)');
const motion=()=>!reduced.matches&&!document.body.classList.contains('motion-off');
const art=$('.project-art'),display=$('.screen-display');
if(!art||!display)return;

/* accent colour and background drawing per app (by name, so the order in projects.js can change) */
const LOOK={
 '数極':['#63e6c4','math'],'物理マスター':['#ff6a58','waves'],'化学マスター':['#49b8ff','molecule'],'生物マスター':['#58d98a','helix'],
 '古文蔵':['#e8b872','tategaki'],'英語マスター':['#ff9a76','penmanship'],'数極 中学':['#46d6c2','geometry'],'情報マスター':['#6f9cff','bits'],
 'カテキ':['#7fb6ff','calendar'],'国語マスター':['#e6c97a','genko'],'地理マスター':['#ff8a5c','globe']};
const look=name=>LOOK[name]||['#70eda8','math'];
// images that are a bare screenshot (no device drawn in them) get a device body in CSS
const RAW=new Set(['物理マスター','英語マスター','情報マスター']);
let current=0;

/* ---------------------------------------------------------------- A. hero ------------------------ */
// fx.css pushes the camera into the wheel's opening. The opening sits a fixed fraction of the drawn
// square away from its centre; where that is inside .core-object depends on the box's proportions, so
// it is measured here whenever the box changes size (never on scroll) and handed to CSS in px.
const coreBox=$('.core-object'),stageBox=$('.opening-stage');
function aimHero(){const w=coreBox.offsetWidth,h=coreBox.offsetHeight;if(!w||!h)return;const side=Math.min(w,h,900),hx=w/2+side*.096,hy=h/2+side*.054,root=document.documentElement.style;
 root.setProperty('--hx',hx.toFixed(1)+'px');root.setProperty('--hy',hy.toFixed(1)+'px');
 root.setProperty('--htx',(stageBox.clientWidth/2-coreBox.offsetLeft-hx).toFixed(1)+'px');root.setProperty('--hty',(stageBox.clientHeight/2-coreBox.offsetTop-hy).toFixed(1)+'px')}
if(coreBox&&stageBox){aimHero();const ro=new ResizeObserver(aimHero);ro.observe(coreBox);ro.observe(stageBox)}

/* ---------------------------------------------------------------- B. artwork slab ---------------- */
const glare=document.createElement('i');glare.className='fx-glare';glare.setAttribute('aria-hidden','true');
const floor=document.createElement('i');floor.className='fx-floor';floor.setAttribute('aria-hidden','true');
display.append(glare,floor);
const video=$('#product-video');
let tiltFrame=0,tiltTo=null,idle=0;
function setTilt(rx,ry,gx,gy){art.style.setProperty('--fx-rx',rx.toFixed(2)+'deg');art.style.setProperty('--fx-ry',ry.toFixed(2)+'deg');art.style.setProperty('--fx-gx',gx.toFixed(1)+'%');art.style.setProperty('--fx-gy',gy.toFixed(1)+'%')}
function rest(){art.classList.remove('is-tracking');setTilt(1.5,-9,38,26)}
function flat(){art.classList.remove('is-tracking');setTilt(0,0,50,28)}
function playing(){return video&&!video.hidden&&!video.paused}
function applyTilt(){tiltFrame=0;if(!tiltTo)return;const r=art.getBoundingClientRect();if(!r.width)return;
 const x=Math.max(0,Math.min(1,(tiltTo.x-r.left)/r.width)),y=Math.max(0,Math.min(1,(tiltTo.y-r.top)/r.height));
 setTilt((.5-y)*13,(x-.5)*24,x*100,y*100)}
function tiltable(){return motion()&&hover.matches&&!playing()}
art.addEventListener('pointermove',e=>{if(!tiltable())return;clearTimeout(idle);art.classList.add('is-tracking');tiltTo={x:e.clientX,y:e.clientY};if(!tiltFrame)tiltFrame=requestAnimationFrame(applyTilt)});
art.addEventListener('pointerleave',()=>{tiltTo=null;clearTimeout(idle);idle=setTimeout(()=>{if(tiltable())rest()},60)});
function syncTilt(){art.classList.add('fx-tilt');art.classList.toggle('is-playing',!!playing());if(!motion()||playing())flat();else if(hover.matches&&!tiltTo)rest();else if(!hover.matches)flat()}
if(video)for(const type of ['play','pause','ended'])video.addEventListener(type,syncTilt);

/* ---------------------------------------------------------------- C. subject drawings ------------ */
const canvas=document.createElement('canvas');canvas.className='fx-motif';canvas.setAttribute('aria-hidden','true');art.prepend(canvas);
const ctx=canvas.getContext('2d');
let W=0,H=0,motif='math',accent='#70eda8',bare=false,started=0,onScreen=false,raf=0,lastDraw=0;
const ease=p=>1-Math.pow(1-Math.max(0,Math.min(1,p)),3);
const rgba=(hex,a)=>{const n=parseInt(hex.slice(1),16);return `rgba(${n>>16&255},${n>>8&255},${n&255},${a})`};
// draws the first `frac` of a polyline
function trace(pts,frac){const n=Math.max(0,Math.min(1,frac))*(pts.length-1);if(n<=0)return;ctx.beginPath();ctx.moveTo(pts[0][0],pts[0][1]);const whole=Math.floor(n);
 for(let i=1;i<=whole;i++)ctx.lineTo(pts[i][0],pts[i][1]);
 if(whole<pts.length-1){const a=pts[whole],b=pts[whole+1],f=n-whole;ctx.lineTo(a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f)}ctx.stroke()}
const seg=(a,b,frac)=>trace([a,b],frac);
function rand(seed){let s=seed>>>0||1;return()=>{s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;return s/4294967296}}
// text written one character at a time in vertical columns, right to left
function vertical(text,font,size,gap,top,right,rows,shown,cell){ctx.font=`${size}px ${font}`;ctx.textAlign='center';ctx.textBaseline='middle';
 const chars=[...text];for(let i=0;i<chars.length&&i<shown;i++){const col=Math.floor(i/rows),row=i%rows,x=right-col*gap,y=top+row*size*1.18;if(x<size)break;
  if(cell)cell(x,y);const fresh=Math.max(0,1-(shown-i)/4);ctx.fillStyle=rgba(accent,.5+fresh*.5);ctx.fillText(chars[i],x,y)}}
const MOTIFS={
 // axes, a sine curve and a parabola, and a tangent sliding along the sine curve
 math(t,p){const ox=W*.5,oy=H*.5,sx=W*.115,sy=H*.13;ctx.strokeStyle=rgba(accent,.3);ctx.lineWidth=1;seg([W*.06,oy],[W*.94,oy],p*1.6);seg([ox,H*.94],[ox,H*.06],p*1.6);
  for(let k=-3;k<=3;k++){if(!k)continue;ctx.globalAlpha=ease(p*2-.4);seg([ox+k*sx,oy-4],[ox+k*sx,oy+4],1);ctx.globalAlpha=1}
  const f=x=>Math.sin(x*1.35+t*.25)*1.9,g=x=>.42*x*x-2.6;const sine=[],para=[];
  for(let i=0;i<=120;i++){const x=-3.8+i*7.6/120;sine.push([ox+x*sx,oy-f(x)*sy]);para.push([ox+x*sx,oy-g(x)*sy])}
  ctx.lineWidth=1.6;ctx.strokeStyle=rgba(accent,.85);trace(sine,p*1.5-.15);ctx.strokeStyle=rgba(accent,.42);trace(para,p*1.5-.4);
  if(p>.8){const a=Math.min(1,(p-.8)*5),x=Math.sin(t*.45)*3,d=(f(x+.01)-f(x-.01))/.02,px=ox+x*sx,py=oy-f(x)*sy,l=1.5;
   ctx.strokeStyle=rgba('#ffffff',.5*a);ctx.lineWidth=1;seg([px-l*sx,py+d*l*sy],[px+l*sx,py-d*l*sy],1);
   ctx.setLineDash([3,4]);ctx.strokeStyle=rgba(accent,.4*a);seg([px,py],[px,oy],1);ctx.setLineDash([]);
   ctx.fillStyle=rgba('#ffffff',.9*a);ctx.beginPath();ctx.arc(px,py,3.2,0,7);ctx.fill()}},
 // circular waves from two sources crossing each other
 waves(t,p){const src=[[W*.3,H*.2],[W*.7,H*.2]],step=46,max=Math.hypot(W,H)*.95;ctx.lineWidth=1.3;
  for(const [x,y] of src){for(let r=(t*26)%step;r<max*ease(p*1.2);r+=step){ctx.strokeStyle=rgba(accent,.6*(1-r/max));ctx.beginPath();ctx.arc(x,y,r,0,Math.PI);ctx.stroke()}
   ctx.fillStyle=rgba('#ffffff',.85);ctx.beginPath();ctx.arc(x,y,3,0,7);ctx.fill()}
  ctx.strokeStyle=rgba(accent,.22);ctx.setLineDash([2,6]);seg([W*.5,H*.2],[W*.5,H*.2+(H*.75)*ease(p)],1);ctx.setLineDash([])},
 // fused six-membered rings; the bonds are drawn in turn and one electron pair goes round a ring
 molecule(t,p){const R=Math.min(W,H)*.15,cx=W*.5,cy=H*.5,dx=R*Math.sqrt(3);const rings=[[0,0],[dx,0],[-dx,0],[dx*.5,R*1.5],[-dx*.5,-R*1.5],[dx*1.5,R*1.5],[-dx*1.5,-R*1.5],[-dx*.5,R*1.5],[dx*.5,-R*1.5],[dx*1.5,-R*1.5],[-dx*1.5,R*1.5]];
  const bonds=[];rings.forEach(([x,y],ri)=>{for(let k=0;k<6;k++){const a=Math.PI/6+k*Math.PI/3,b=a+Math.PI/3;bonds.push([[cx+x+R*Math.cos(a),cy+y+R*Math.sin(a)],[cx+x+R*Math.cos(b),cy+y+R*Math.sin(b)],ri,k])}});
  bonds.forEach(([a,b,ri,k],i)=>{const f=p*bonds.length*1.15-i;if(f<=0)return;ctx.strokeStyle=rgba(accent,.7);ctx.lineWidth=1.5;seg(a,b,f);
   if(k%2===0&&f>=1){const mx=cx+rings[ri][0],my=cy+rings[ri][1],q=.84;ctx.strokeStyle=rgba(accent,.36);ctx.lineWidth=1;seg([mx+(a[0]-mx)*q,my+(a[1]-my)*q],[mx+(b[0]-mx)*q,my+(b[1]-my)*q],1)}
   if(f>=1){ctx.fillStyle=rgba(accent,.9);ctx.beginPath();ctx.arc(a[0],a[1],2.2,0,7);ctx.fill()}});
  if(p>.9){const a=t*1.4;for(const s of [0,Math.PI]){ctx.fillStyle=rgba('#ffffff',.9);ctx.beginPath();ctx.arc(cx+R*.56*Math.cos(a+s),cy+R*.56*Math.sin(a+s),2.4,0,7);ctx.fill()}}},
 // a double helix turning about its axis
 helix(t,p){const top=H*.04,len=H*.92*ease(p),k=.021*560/Math.max(360,H);for(const [cx,A,w] of bare?[[W*.5,W*.17,t*.8]]:[[W*.1,W*.075,t*.8],[W*.9,W*.075,-t*.8+1.3]]){
  for(const ph of [0,Math.PI]){const pts=[];for(let y=0;y<=len;y+=4)pts.push([cx+A*Math.sin(y*k+w+ph),top+y]);ctx.lineWidth=1.8;ctx.strokeStyle=rgba(accent,ph?.5:.85);trace(pts,1)}
  ctx.lineWidth=1.2;for(let y=10;y<=len;y+=20){const s=Math.sin(y*k+w),depth=Math.cos(y*k+w);ctx.strokeStyle=rgba(accent,.16+.3*Math.abs(depth));seg([cx+A*s,top+y],[cx-A*s,top+y],1);
   ctx.fillStyle=rgba('#ffffff',.3+.45*Math.max(0,depth));ctx.beginPath();ctx.arc(cx+A*s,top+y,2,0,7);ctx.fill()}}},
 // the opening of Makura no Soshi, written down the page
 tategaki(t,p,since){const size=Math.max(17,Math.min(24,W/19)),rows=Math.max(6,Math.floor(H*.84/(size*1.18)));
  ctx.strokeStyle=rgba(accent,.16);ctx.lineWidth=1;const gap=size*2.1,right=W-size*1.6;for(let x=right+gap/2;x>size;x-=gap)seg([x,H*.06],[x,H*.06+H*.88*ease(p*1.4)],1);
  vertical('春はあけぼの。やうやう白くなりゆく山ぎは、少し明かりて、紫だちたる雲の細くたなびきたる。夏は夜。月のころはさらなり。闇もなほ、蛍の多く飛びちがひたる。また、ただ一つ二つなど、ほのかにうち光りて行くもをかし。雨など降るもをかし。',"'Hiragino Mincho ProN','Yu Mincho',serif",size,gap,H*.09,right,rows,Math.floor(since*9))},
 // four-line ruling with a sentence being written on it
 penmanship(t,p,since){const lines=['What do you want','to learn today?','Read. Listen.','Think it through.'],size=Math.max(20,Math.min(32,W/15)),left=W*.09,block=size*2.9,top=H*.5-block*lines.length/2+size;
  let typed=Math.floor(since*11);lines.forEach((text,i)=>{const y=top+i*block;ctx.lineWidth=1;
   [[-size*.95,.16],[-size*.5,.1],[0,.38],[size*.32,.1]].forEach(([dy,a],j)=>{ctx.strokeStyle=rgba(accent,a);if(j===1)ctx.setLineDash([4,5]);seg([left,y+dy],[left+(W-left*2)*ease(p*1.5-i*.12),y+dy],1);ctx.setLineDash([])});
   const part=text.slice(0,Math.max(0,typed));typed-=text.length;ctx.font=`italic ${size}px Georgia,'Times New Roman',serif`;ctx.textBaseline='alphabetic';ctx.fillStyle=rgba(accent,.8);const full=ctx.measureText(text).width,tx=bare||i%2===0?left+6:W-left-6-full;ctx.textAlign='left';ctx.fillText(part,tx,y);
   if(part.length&&part.length<text.length&&Math.floor(t*2)%2===0){ctx.fillStyle=rgba('#ffffff',.8);ctx.fillRect(tx+2+ctx.measureText(part).width,y-size*.85,1.5,size)}})},
 // a triangle, its perpendicular bisectors and the circle through its corners
 geometry(t,p){const cx=W*.5,cy=H*.5,R=Math.min(W,H)*.34,ang=[-1.95,-.35,2.35].map(a=>a+Math.sin(t*.15)*.08),P=ang.map(a=>[cx+R*Math.cos(a),cy+R*Math.sin(a)]);
  ctx.lineWidth=1.6;ctx.strokeStyle=rgba(accent,.85);for(let i=0;i<3;i++)seg(P[i],P[(i+1)%3],p*4-i*.6);
  ctx.lineWidth=1;ctx.setLineDash([4,5]);ctx.strokeStyle=rgba(accent,.4);for(let i=0;i<3;i++){const a=P[i],b=P[(i+1)%3];seg([(a[0]+b[0])/2,(a[1]+b[1])/2],[cx,cy],p*3-1.1-i*.2)}ctx.setLineDash([]);
  const c=ease(p*2.2-1.2);if(c>0){ctx.strokeStyle=rgba(accent,.5);ctx.beginPath();ctx.arc(cx,cy,R,-Math.PI/2,-Math.PI/2+c*Math.PI*2);ctx.stroke();
   const a=-Math.PI/2+c*Math.PI*2;ctx.strokeStyle=rgba('#ffffff',.35*(1-c)+.0);seg([cx,cy],[cx+R*Math.cos(a),cy+R*Math.sin(a)],1)}
  for(const q of P){ctx.fillStyle=rgba('#ffffff',.9*ease(p*3));ctx.beginPath();ctx.arc(q[0],q[1],3,0,7);ctx.fill()}ctx.fillStyle=rgba(accent,.9*c);ctx.beginPath();ctx.arc(cx,cy,2.6,0,7);ctx.fill()},
 // a field of bits; some flip every half second, a few rows light up as if being read
 bits(t,p){const size=Math.max(11,Math.min(15,W/32)),cw=size*1.55,ch=size*1.9,cols=Math.ceil(W/cw),rows=Math.ceil(H/ch),tick=Math.floor(t*2),hot=Math.floor(t*1.2)%rows;
  ctx.font=`${size}px ui-monospace,Menlo,monospace`;ctx.textAlign='center';ctx.textBaseline='middle';
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){const id=r*131+c*17,rnd=rand(id*7919+1)(),flips=rnd<.22?tick:0,bit=rand(id*104729+flips*31+3)()<.5?'0':'1';
   if((c+r*.6)/(cols+rows*.6)>ease(p)*1.15)continue;const lit=r===hot?.55:0;ctx.fillStyle=rgba(bit==='1'?accent:'#9fb4c8',(bit==='1'?.5:.2)+lit*(bit==='1'?1:.4));ctx.fillText(bit,c*cw+cw/2,r*ch+ch/2)}},
 // a month of lessons filling up with check marks
 calendar(t,p,since){const cols=7,rows=5,gw=W*.8,cell=gw/cols,gh=cell*rows,x0=(W-gw)/2,y0=(H-gh)/2;ctx.lineWidth=1;ctx.strokeStyle=rgba(accent,.3);
  for(let c=0;c<=cols;c++)seg([x0+c*cell,y0],[x0+c*cell,y0+gh*ease(p*1.5-c*.05)],1);for(let r=0;r<=rows;r++)seg([x0,y0+r*cell],[x0+gw*ease(p*1.5-r*.07),y0+r*cell],1);
  const days=[2,4,9,11,16,18,23,25,30,32],n=Math.floor(since*2.2)%(days.length+5);ctx.font=`${Math.max(9,cell*.2)}px ui-monospace,Menlo,monospace`;ctx.textAlign='left';ctx.textBaseline='top';
  for(let i=0;i<cols*rows&&p>.6;i++){ctx.fillStyle=rgba(accent,.4);ctx.fillText(String(i+1>31?i-30:i+1),x0+(i%cols)*cell+5,y0+Math.floor(i/cols)*cell+5)}
  days.forEach((d,i)=>{if(i>=n||p<.7)return;const x=x0+(d%cols)*cell,y=y0+Math.floor(d/cols)*cell;ctx.fillStyle=rgba(accent,.14);ctx.fillRect(x+1,y+1,cell-2,cell-2);
   ctx.strokeStyle=rgba('#ffffff',.85);ctx.lineWidth=2;trace([[x+cell*.3,y+cell*.56],[x+cell*.45,y+cell*.7],[x+cell*.72,y+cell*.38]],i===n-1?(since*2.2%1)*1.6:1)})},
 // manuscript paper being filled in (the opening of Kusamakura)
 genko(t,p,since){const size=Math.max(18,Math.min(26,W/17)),pitch=size*1.18,gap=size*1.75,right=W-size*1.5,rows=Math.max(6,Math.floor(H*.84/pitch)),top=H*.08+size/2;
  ctx.lineWidth=1;ctx.strokeStyle=rgba(accent,.2);const cols=Math.floor((right-size)/gap)+1;
  for(let c=0;c<cols;c++){const x=right-c*gap;if((c/cols)>ease(p*1.3))break;for(let r=0;r<rows;r++)ctx.strokeRect(x-pitch/2,top+r*pitch-pitch/2,pitch,pitch)}
  vertical('山路を登りながら、こう考えた。智に働けば角が立つ。情に棹させば流される。意地を通せば窮屈だ。とかくに人の世は住みにくい。住みにくさが高じると、安い所へ引き越したくなる。どこへ越しても住みにくいと悟った時、詩が生れて、画が出来る。',"'Hiragino Mincho ProN','Yu Mincho',serif",size*.82,gap,top,right,rows,Math.floor(Math.max(0,since-.6)*8))},
 // a globe's graticule turning slowly
 globe(t,p){const cx=W*.5,cy=H*.5,R=Math.min(W,H)*.4*ease(p*1.3),tilt=.38,spin=t*.16;if(R<4)return;ctx.lineWidth=1;
  const proj=(lat,lon)=>{const x=Math.cos(lat)*Math.sin(lon),y=Math.sin(lat),z=Math.cos(lat)*Math.cos(lon);return [cx+R*x,cy-R*(y*Math.cos(tilt)-z*Math.sin(tilt)),y*Math.sin(tilt)+z*Math.cos(tilt)]};
  const curve=(fn,strong)=>{let open=false;ctx.beginPath();for(let i=0;i<=72;i++){const [x,y,z]=fn(i/72);if(z<0){open=false;continue}if(open)ctx.lineTo(x,y);else ctx.moveTo(x,y);open=true}ctx.strokeStyle=rgba(accent,strong?.75:.36);ctx.stroke()};
  for(let k=0;k<12;k++){const lon=k*Math.PI/6+spin;curve(f=>proj(-Math.PI/2+f*Math.PI,lon),k%6===0)}
  for(let k=-2;k<=2;k++){const lat=k*Math.PI/6;curve(f=>proj(lat,f*Math.PI*2+spin),k===0)}
  ctx.strokeStyle=rgba(accent,.6);ctx.lineWidth=1.4;ctx.beginPath();ctx.arc(cx,cy,R,0,7);ctx.stroke()}
};
function sizeCanvas(){const r=art.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,1.5),w=Math.round(r.width),h=Math.round(r.height);if(!w||!h)return false;
 if(w!==W||h!==H||canvas.width!==Math.round(w*dpr)){W=w;H=h;canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0)}return true}
function paint(now){if(!sizeCanvas())return;const since=motion()?(now-started)/1000:60,t=motion()?now/1000:0;ctx.clearRect(0,0,W,H);ctx.setLineDash([]);ctx.globalAlpha=1;ctx.lineCap='round';ctx.lineJoin='round';
 (MOTIFS[motif]||MOTIFS.math)(t,ease(since/2.4),since)}
function loop(now){raf=0;if(!onScreen||document.hidden||!motion())return;if(now-lastDraw>=33){lastDraw=now;paint(now)}raf=requestAnimationFrame(loop)}
function wake(){if(raf)return;if(onScreen&&!document.hidden&&motion())raf=requestAnimationFrame(loop);else if(onScreen)paint(performance.now())}
new IntersectionObserver(([e])=>{onScreen=e.isIntersecting;wake()},{threshold:0}).observe(art);
new ResizeObserver(()=>{if(!raf&&onScreen)paint(performance.now())}).observe(art);
document.addEventListener('visibilitychange',wake);reduced.addEventListener('change',()=>{syncTilt();wake()});hover.addEventListener('change',syncTilt);
new MutationObserver(()=>{syncTilt();wake()}).observe(document.body,{attributes:true,attributeFilter:['class']});

function show(index){current=index;const p=projects[index];if(!p)return;[accent,motif]=look(p.name);bare=!p.screen;started=performance.now();
 art.style.setProperty('--fx-accent',accent);display.classList.toggle('is-raw',RAW.has(p.name)&&!p.video);syncTilt();wake();if(!motion()&&onScreen)paint(started)}
document.addEventListener('iwant:select',e=>show(e.detail.index));

/* ---------------------------------------------------------------- D. transitions ----------------- */
// hero card -> works: the card's screenshot becomes the artwork of the works panel
const tabs=$$('[data-select]'),header=$('.header');
function jump(index){for(const el of $$('.works-heading,.project-console,.project-art,.project-info'))el.classList.add('is-in','rv-done');
 tabs[index]&&tabs[index].click();const y=$('.project-console').getBoundingClientRect().top+scrollY-(header?header.offsetHeight:0)-14;window.scrollTo({top:y,behavior:'instant'})}
for(const card of $$('.collection-card[data-project]')){card.addEventListener('click',e=>{
 if(!document.startViewTransition||!motion()||e.metaKey||e.ctrlKey||e.shiftKey||e.button)return;e.preventDefault();
 const img=card.querySelector('.card-preview>img'),index=Number(card.dataset.project);if(img)img.style.viewTransitionName='fx-device';
 const done=()=>{display.style.viewTransitionName='';if(img)img.style.viewTransitionName=''};
 try{const vt=document.startViewTransition(()=>{if(img)img.style.viewTransitionName='';jump(index);display.style.viewTransitionName='fx-device';history.replaceState(null,'','#works')});vt.finished.then(done,done)}
 catch(_){done();jump(index)}})}
// support pages that live in this repository opt in to cross-document transitions (fx.css on this
// side, one rule in their own <style>); those open in the same tab so the title can carry over
const SAME_TAB=/^https:\/\/ottub\.github\.io\/(kokugo|geography)\//;
const support=$('#support-link');
function syncSupport(){if(!support)return;const href=support.getAttribute('href')||'',m=SAME_TAB.exec(href);
 if(m){support.removeAttribute('target');if(location.hostname!=='ottub.github.io')support.setAttribute('href',href.replace('https://ottub.github.io/',new URL('.',location.href).href))}else support.setAttribute('target','_blank')}
document.addEventListener('iwant:select',syncSupport);

/* ---------------------------------------------------------------- E. timeline -------------------- */
function timeline(){const grid=$('.update-grid');if(!grid)return;const cards=$$('.update-card');if(cards.length<2)return;
 const NS='http://www.w3.org/2000/svg',el=(name,attrs={},text)=>{const n=document.createElementNS(NS,name);for(const k in attrs)n.setAttribute(k,attrs[k]);if(text!=null)n.textContent=text;return n};
 const items=cards.map((card,i)=>{const meta=card.querySelector('.update-meta span').textContent.split('/').map(s=>s.trim()),time=card.querySelector('time');card.id=card.id||'update-'+(cards.length-i);
  return {card,app:meta[0],version:meta[1]||'',date:new Date(time.dateTime+'T00:00:00'),label:time.textContent,title:card.querySelector('h3').textContent,launch:!card.querySelector('p')}});
 const apps=[...new Set(items.map(it=>it.app))];const first=Math.min(...items.map(it=>+it.date)),last=Math.max(...items.map(it=>+it.date)),DAY=864e5;
 const box=document.createElement('div');box.className='fx-timeline';
 const head=document.createElement('div');head.className='fx-tl-head';const range=items[items.length-1].label+' — '+items[0].label;head.innerHTML='<span></span><span></span>';head.firstChild.textContent='年表';head.lastChild.textContent=range+' / '+items.length+'件';
 const tip=document.createElement('div');tip.className='fx-tl-tip';tip.setAttribute('aria-hidden','true');
 const holder=document.createElement('div');const filter=document.createElement('div');filter.className='fx-tl-filter';filter.setAttribute('role','group');filter.setAttribute('aria-label','アプリで絞り込む');
 const legend=document.createElement('div');legend.className='fx-tl-legend';legend.innerHTML='<span><i class="launch"></i>公開</span><span><i></i>アップデート</span>';
 box.append(head,holder,legend,filter,tip);grid.before(box);
 let picked=null;const lanes=new Map();
 function draw(){const width=Math.max(280,Math.round(holder.clientWidth)),narrow=width<560,gutter=narrow?92:128,padR=16,row=narrow?26:30,top=26,height=top+apps.length*row+6;
  const x=d=>gutter+(width-gutter-padR)*((+d-first)/Math.max(DAY,last-first));
  const svg=el('svg',{class:'fx-tl-svg',viewBox:`0 0 ${width} ${height}`,width,height,role:'group','aria-label':'アプリ別の更新の年表'});lanes.clear();
  for(let d=new Date(first),n=0;+d<=last;d=new Date(+d+7*DAY),n++){const px=x(d);svg.append(el('line',{class:'tl-week',x1:px,x2:px,y1:top-8,y2:height-4}));
   if(!narrow||n%2===0)svg.append(el('text',{class:'tl-date',x:px,y:12},`${d.getMonth()+1}.${String(d.getDate()).padStart(2,'0')}`))}
  apps.forEach((app,i)=>{const y=top+i*row+row/2,color=look(app)[0],mine=items.filter(it=>it.app===app).sort((a,b)=>a.date-b.date);
   const g=el('g',{class:'tl-lane'+(picked===app?' is-picked':''),style:`color:${color}`});lanes.set(app,g);
   g.append(el('text',{class:'tl-name',x:0,y:y+4},app),el('line',{class:'tl-base',x1:gutter,x2:width-padR,y1:y,y2:y}));
   if(mine.length>1)g.append(el('path',{class:'tl-line',d:`M${x(mine[0].date)} ${y}H${x(mine[mine.length-1].date)}`,stroke:color,pathLength:1,style:`--d:${i*90}ms`}));
   mine.forEach((it,k)=>{const px=x(it.date),a=el('a',{class:'tl-dot'+(it.launch?' is-launch':''),href:'#'+it.card.id,'aria-label':`${it.app} ${it.version}、${it.label}、${it.title}`,style:`--d:${i*90+300+k*140}ms`});
    a.append(el('rect',{class:'tl-hit',x:px-11,y:y-row/2,width:22,height:row}),el('circle',{class:'halo',cx:px,cy:y,r:12,fill:color}),el('circle',{class:'ring',cx:px,cy:y,r:5}),el('circle',{class:'pt',cx:px,cy:y,r:it.launch?5:4.5,fill:color}));
    const on=()=>{tip.replaceChildren();const b=document.createElement('b'),s=document.createElement('small'),h=document.createElement('span');b.textContent=it.app+' '+it.version;s.textContent=it.label+(it.launch?' / 公開':'');h.textContent=it.title;tip.append(b,s,h);
     const hr=holder.getBoundingClientRect(),br=box.getBoundingClientRect();tip.style.left=Math.max(125,Math.min(br.width-125,hr.left-br.left+px))+'px';tip.style.top=(hr.top-br.top+y)+'px';tip.classList.add('is-on')};
    const off=()=>tip.classList.remove('is-on');a.addEventListener('pointerenter',on);a.addEventListener('focus',on);a.addEventListener('pointerleave',off);a.addEventListener('blur',off);
    a.addEventListener('click',e=>{e.preventDefault();off();if(picked&&picked!==it.app)pick(null);it.card.classList.add('is-in','rv-done');it.card.style.setProperty('--fx-flash',color);it.card.scrollIntoView({behavior:motion()?'smooth':'auto',block:'center'});
     it.card.classList.remove('fx-flash');void it.card.offsetWidth;it.card.classList.add('fx-flash')});
    g.append(a)});svg.append(g)});
  holder.replaceChildren(svg)}
 function pick(app){picked=picked===app?null:app;box.classList.toggle('has-filter',!!picked);for(const [name,g] of lanes)g.classList.toggle('is-picked',name===picked);
  for(const b of filter.children)b.setAttribute('aria-pressed',String((b.dataset.app||null)===picked));
  for(const it of items){it.card.hidden=!!picked&&it.app!==picked;if(!it.card.hidden)it.card.classList.add('is-in','rv-done')}}
 const chip=(app,count)=>{const b=document.createElement('button');b.type='button';b.setAttribute('aria-pressed',String(!app));if(app){b.dataset.app=app;b.style.setProperty('--c',look(app)[0]);b.append(document.createElement('i'))}
  b.append(app||'すべて');const n=document.createElement('b');n.textContent=count;b.append(n);b.addEventListener('click',()=>pick(app&&picked!==app?app:null));return b};
 filter.append(chip(null,items.length),...apps.map(app=>chip(app,items.filter(it=>it.app===app).length)));
 draw();let lastWidth=holder.clientWidth;new ResizeObserver(()=>{if(Math.abs(holder.clientWidth-lastWidth)>1){lastWidth=holder.clientWidth;draw()}}).observe(holder);
 if('IntersectionObserver' in window&&motion()){const io=new IntersectionObserver(([e])=>{if(e.isIntersecting||e.boundingClientRect.bottom<=0){box.classList.add('is-in');io.disconnect()}},{rootMargin:'0px 0px -18% 0px'});io.observe(box)}else box.classList.add('is-in');
}
try{timeline()}catch(error){console.warn('Timeline unavailable.',error)}

show(Math.max(0,tabs.findIndex(b=>b.getAttribute('aria-selected')==='true')));syncSupport();
})();
