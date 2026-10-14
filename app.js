(()=>{'use strict';
const $=s=>document.querySelector(s),clamp=v=>Math.max(0,Math.min(1,v)),projects=window.IWANT_PROJECTS;
const reduced=matchMedia('(prefers-reduced-motion:reduce)'),short=matchMedia('(max-height:650px)'),mobile=matchMedia('(max-width:700px)');
const opening=$('.opening'),stage=$('.opening-stage'),copy=$('.opening-copy'),core=$('.core-object'),gallery=$('.collection-preview'),invite=$('.scroll-invitation'),toggle=$('#motion');
let enabled=!reduced.matches,frame=0,selected=0;
/* Hero scroll effect (the wheel shrinks and dims, the copy lifts out, the app cards rise in).
   Where CSS scroll-driven animations exist (html.hero-sda, hero.css), the browser runs the effect on
   its own from the scroll position: no script runs while scrolling, and in Safari 26.4+ / Chromium it
   is updated off the main thread, so a busy page cannot make it stutter. Only the inert/aria-hidden
   switches of the copy and the cards stay in script, driven by IntersectionObserver on two markers
   placed at those scroll positions (hero.css), so they also fire only when crossed.
   Elsewhere the same effect is written from a scroll listener (older browsers): layout is measured
   only when it can have changed, a frame reads scrollY alone and writes only values that differ. */
const sda=!!(window.CSS&&CSS.supports&&CSS.supports('animation-timeline:scroll()')&&CSS.supports('animation-range:0px 1px')&&CSS.supports('animation-duration:auto'))&&new URLSearchParams(location.search).get('hero')!=='js';
document.documentElement.classList.toggle('hero-sda',sda);
let geo=null;const out={};
function motion(){return enabled&&!reduced.matches}
function measure(){geo={header:$('.header').offsetHeight,top:opening.getBoundingClientRect().top+scrollY,range:Math.max(1,opening.offsetHeight-stage.offsetHeight)}}
function put(key,el,prop,value){if(out[key]!==value){out[key]=value;el.style[prop]=value}}
function hide(key,el,on){if(out[key]!==on){out[key]=on;el.inert=on;el.setAttribute('aria-hidden',String(on))}}
// copy hidden once it has faded (p > .393), cards usable once nearly in place (p >= .66); see hero.css
const past={copy:false,cards:false};
function states(active,copyGone,cardsIn){hide('ph',copy,active&&copyGone);hide('gh',gallery,!active||!cardsIn)}
function render(){frame=0;if(sda){states(motion()&&!short.matches,past.copy,past.cards);return}
 if(!geo)measure();const active=motion()&&!short.matches,phone=mobile.matches;
 const p=active?clamp((geo.header+scrollY-geo.top)/geo.range):0;
 if(p===out.p&&active===out.active&&phone===out.phone)return;out.p=p;out.active=active;out.phone=phone;
 const fade=clamp((p-.05)/.35),show=clamp((p-.3)/.4);
 put('ct',core,'transform',`translate(${p*-12}%,${p*-15}%) scale(${1-p*.48})`);put('co',core,'opacity',String((phone?.88:1)-p*.8));
 put('pt',copy,'transform',phone?`translateY(${-fade*30}px)`:`translateY(calc(-55% - ${fade*30}px))`);put('po',copy,'opacity',String(1-fade));
 put('gt',gallery,'transform',`translateY(${(1-show)*80}px)`);put('go',gallery,'opacity',String(show));states(active,fade>.98,show>=.9);
 put('io',invite,'opacity',String(1-clamp(p*4)));
}
function schedule(){if(!frame&&!document.hidden)frame=requestAnimationFrame(render)}
function invalidate(){geo=null;out.p=undefined;schedule()}
if(sda){
 // markers sit at the scroll offsets where the thresholds are crossed; a marker above the top edge
 // of the viewport means that point has been scrolled past
 const marks=[['copy','hero-mark-copy'],['cards','hero-mark-cards']].map(([key,cls])=>{const m=document.createElement('i');m.className='hero-mark '+cls;m.setAttribute('aria-hidden','true');m.dataset.key=key;opening.append(m);return m});
 const markObserver=new IntersectionObserver(entries=>{for(const e of entries)past[e.target.dataset.key]=!e.isIntersecting&&e.boundingClientRect.top<(e.rootBounds?e.rootBounds.top:0);schedule()},{threshold:0});
 marks.forEach(m=>markObserver.observe(m));
}
function sync(){const on=motion();document.body.classList.toggle('motion-off',!on);document.documentElement.style.scrollBehavior=on?'smooth':'auto';toggle.setAttribute('aria-pressed',String(on));toggle.querySelector('span').textContent=on?'ON':'OFF';toggle.disabled=reduced.matches;toggle.setAttribute('aria-label',reduced.matches?'端末の設定に従って動きを抑制中':on?'動きを停止する':'動きを再開する');if(!on)enterAll();invalidate()}
toggle.addEventListener('click',()=>{const anchor=opening.getBoundingClientRect().bottom>$('.header').offsetHeight&&opening.getBoundingClientRect().top<innerHeight;enabled=!enabled;sync();if(anchor)window.scrollTo({top:0,behavior:'instant'})});
reduced.addEventListener('change',sync);short.addEventListener('change',invalidate);mobile.addEventListener('change',invalidate);if(!sda)window.addEventListener('scroll',schedule,{passive:true});window.addEventListener('resize',invalidate);window.addEventListener('load',invalidate);const sizes=new ResizeObserver(invalidate);sizes.observe(stage);sizes.observe(opening);document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(frame);frame=0}else schedule()});
const tabs=[...document.querySelectorAll('[data-select]')],tabNav=$('#project-nav');
function reveal(b){if(!tabNav||tabNav.scrollWidth<=tabNav.clientWidth+1)return;const l=b.offsetLeft,r=l+b.offsetWidth,pad=24;let x=null;if(l<tabNav.scrollLeft+pad)x=l-pad;else if(r>tabNav.scrollLeft+tabNav.clientWidth-pad)x=r-tabNav.clientWidth+pad;if(x!==null)tabNav.scrollTo({left:Math.max(0,x),behavior:motion()?'smooth':'auto'})}
const lines=(el,text)=>el.replaceChildren(...text.split('\n').flatMap((s,i)=>i?[document.createElement('br'),document.createTextNode(s)]:[document.createTextNode(s)]));
function select(index,focus=false,animate=true){const previous=selected;selected=index;const p=projects[index];
 for(const el of [$('.screen-display'),$('.dev-visual'),$('.project-info')])el.getAnimations().forEach(a=>a.cancel());
 tabs.forEach((b,i)=>{b.setAttribute('aria-selected',String(i===index));b.tabIndex=i===index?0:-1;if(focus&&i===index)b.focus({preventScroll:true})});if(animate)reveal(tabs[index]);
 $('#project-panel').setAttribute('aria-labelledby','tab-'+index);$('#project-name').textContent=p.name;$('#project-kind').textContent=p.kind+' / '+p.field;
 lines($('#product-headline'),p.headline);lines($('#project-copy'),p.copy);$('#project-note').textContent=p.note;$('#release-badge').textContent=p.state;$('#release-badge').classList.toggle('is-dev',!p.url);$('#price-note').textContent=p.price;
 $('#product-features').hidden=!p.features.length;$('#product-features').replaceChildren(...p.features.map(([title,copy])=>{const li=document.createElement('li'),a=document.createElement('strong'),b=document.createElement('span');a.textContent=title;b.textContent=copy;li.append(a,b);return li}));
 $('#product-icon').hidden=!p.icon;if(p.icon){$('#product-icon').src=p.icon;$('#product-icon').alt=p.name+'のアプリアイコン'}
 if(!p.screen){lines($('#dev-visual-text'),p.devText||p.name);$('#dev-visual-note').textContent=p.devNote||p.name+' / '+p.state}
 $('#screen-open').hidden=!p.screen;$('#dev-visual').hidden=!!p.screen;$('.project-art').classList.toggle('is-dev',!p.screen);$('#screen-note').textContent=p.screenNote;
 if(p.screen){$('#product-screen').src=p.screen;$('#product-screen').alt=p.screenAlt;$('#screen-open').setAttribute('aria-label',p.name+'の画像を拡大')}
 $('#store-link').hidden=!p.url;$('#support-link').hidden=!p.support;$('#development-state').hidden=!!p.url;
 if(p.url)$('#store-link').href=p.url;else $('#store-link').removeAttribute('href');if(p.support)$('#support-link').href=p.support;else $('#support-link').removeAttribute('href');
 if(animate&&previous!==index&&motion()){const direction=index>previous?1:-1;const image=p.screen?$('.screen-display'):$('.dev-visual');image.animate([{opacity:0,transform:`translateX(${direction*45}px) scale(.96)`},{opacity:1,transform:'translateX(0) scale(1)'}],{duration:420,easing:'cubic-bezier(.2,.7,.2,1)'});$('.project-info').animate([{opacity:0,transform:`translateX(${direction*18}px)`},{opacity:1,transform:'translateX(0)'}],{duration:330,easing:'ease-out'})}
}
tabs.forEach((b,i)=>{b.addEventListener('click',()=>select(i));b.addEventListener('keydown',e=>{let n;if(e.key==='ArrowRight')n=(selected+1)%tabs.length;else if(e.key==='ArrowLeft')n=(selected+tabs.length-1)%tabs.length;else if(e.key==='Home')n=0;else if(e.key==='End')n=tabs.length-1;else return;e.preventDefault();select(n,true)})});
document.querySelectorAll('[data-project]').forEach(a=>a.addEventListener('click',()=>select(Number(a.dataset.project))));
const dialog=$('#screen-dialog');$('#screen-open').addEventListener('click',()=>{const p=projects[selected];if(!p.screen)return;$('#image-dialog-img').src=p.screen;$('#image-dialog-img').alt=p.screenAlt;$('#image-dialog-label').textContent=p.name+' / '+p.screenNote;dialog.showModal();document.body.style.overflow='hidden'});
$('#screen-close').addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>{document.body.style.overflow='';$('#screen-open').focus()});dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close()});
/* Reveal on scroll for the blocks below the hero. Each group enters once (IntersectionObserver +
   classes, no scroll listener); reveal.css animates only transform, opacity and clip-path. Content is
   hidden only while html.rv-on is set, so without JS (or if this setup fails) everything is visible.
   Groups already scrolled past (anchor jump, reload lower on the page) and every group when motion is
   OFF or reduced are shown at once without animation. */
const rvGroups=[...document.querySelectorAll('.works-heading,.project-console,.project-art,.project-info,.preview-note,.song .subsection-heading,.song-player,.song-note,.updates .subsection-heading,.update-card,.about,.support-grid,.support-list,.site-footer')];
let rvObserver=null;
function enter(el,instant){if(rvObserver)rvObserver.unobserve(el);if(el.classList.contains('rv-done'))return;if(instant){el.classList.add('is-in','rv-done');if(el.getAnimations)el.getAnimations({subtree:true}).forEach(a=>{if(window.CSSTransition&&a instanceof CSSTransition)a.finish()});return}if(el.classList.contains('is-in'))return;el.classList.add('is-in');setTimeout(()=>el.classList.add('rv-done'),2400)}
function enterAll(){rvGroups.forEach(el=>enter(el,true))}
// a jump (anchor, restored scroll) can carry a group from below the viewport to above it without any
// intersection change; once a later group enters, earlier ones lying fully above are shown as they are
function passed(el){for(const g of rvGroups){if(g===el)break;if(!g.classList.contains('is-in')&&g.getBoundingClientRect().bottom<=0)enter(g,true)}}
if('IntersectionObserver' in window){
 for(const sel of ['.project-tabs>button','.project-info>*','.about-copy>p','.support-list>a'])document.querySelectorAll(sel).forEach((el,i)=>el.style.setProperty('--i',i));
 rvObserver=new IntersectionObserver(entries=>{for(const e of entries){if(e.isIntersecting){enter(e.target,!motion());passed(e.target)}else if(e.boundingClientRect.bottom<=0)enter(e.target,true)}},{rootMargin:'0px 0px -10% 0px',threshold:0});
 rvGroups.forEach(el=>{el.classList.add('rv');rvObserver.observe(el)});
 document.addEventListener('focusin',e=>{for(let g=e.target.closest&&e.target.closest('.rv');g;g=g.parentElement&&g.parentElement.closest('.rv'))enter(g,true)});
 document.documentElement.classList.add('rv-on');
}
sync();select(0,false,false);
})();
