// ============================================================================
//  Commit Force — Field Guide renderer (shared by elements.html + help.html).
//
//  Drops a live, animated catalog of every game element into the page: include
//  this script and add an empty  <div id="field-guide"></div>  where you want
//  the grid. It injects its own (scoped) styles and pauses its render loop
//  while the container is hidden, so it's cheap to embed in a hidden tab.
//
//  The sprite routines below are MIRRORED VERBATIM from play.html so the guide
//  renders every element exactly as the game does. If a sprite changes in
//  play.html, update its twin here. Everything else (the mini canvas
//  environment, the card config, the render loop) is unique to the guide.
// ============================================================================
(function () {
  const container = document.getElementById("field-guide");
  if (!container) return;

  // --- inject the guide's styles once, scoped under #field-guide so they can't
  //     leak into whatever page (elements.html / help.html) is hosting us ---
  if (!document.getElementById("fg-style")) {
    const st = document.createElement("style"); st.id = "fg-style";
    st.textContent = `
      #field-guide *{ box-sizing:border-box; }
      #field-guide .fg-grid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); gap:16px; }
      #field-guide .card{ margin:0; background:#120a0e; border:2px solid #2a1015; padding:12px 14px 16px; display:flex; flex-direction:column; }
      #field-guide .card.wide{ grid-column:1 / -1; }
      #field-guide .screen{ background:#0a0608; border:1px solid #2a1620; box-shadow:0 0 0 2px #000 inset;
        display:flex; align-items:flex-end; justify-content:center; padding:10px; min-height:120px; overflow:hidden; }
      #field-guide canvas{ image-rendering:pixelated; image-rendering:crisp-edges; max-width:100%; height:auto; }
      #field-guide .head{ display:flex; align-items:baseline; justify-content:space-between; gap:8px; margin:12px 0 4px; flex-wrap:wrap; }
      #field-guide h3{ margin:0; font-size:16px; letter-spacing:1px; color:#e04a4a; text-shadow:2px 2px 0 #000; }
      #field-guide .chip{ font-size:9px; letter-spacing:1.5px; padding:2px 6px; border:1px solid currentColor; border-radius:2px; white-space:nowrap; }
      #field-guide .card p{ margin:6px 0 0; font-size:12.5px; line-height:1.6; color:#d4c0c5; }
      #field-guide .card p b{ color:#e7b7bd; }
      #field-guide .card p .sp{ color:#8fd8a0; }
      #field-guide .card p .lv{ color:#e6a06a; }
      @media (max-width:480px){ #field-guide .fg-grid{ grid-template-columns:1fr; } }`;
    document.head.appendChild(st);
  }

  // --- game constants the sprites read ---
  const GROUND_Y = 1000, PUNCH_T = 12, KICK_T = 22;

  // --- mutable "camera"/frame globals, re-pointed at each mini canvas before a draw ---
  let g, W, H, camX = 0, camY = 0, time = 0, safe = null;

  // --- color helpers (from play.html) ---
  const hx = h => { h = h.replace('#',''); return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]; };
  const rh = r => '#'+r.map(v=>Math.max(0,Math.min(255,v|0)).toString(16).padStart(2,'0')).join('');
  const darken  = (h,f) => rh(hx(h).map(v=>v*f));
  const lighten = (h,f) => rh(hx(h).map(v=>v+(255-v)*f));
  const palette = b => ({ base:b, dark:darken(b,0.6), light:lighten(b,0.34) });
  const hpCol = p => p>0.5?"#6fd08a":p>0.25?"#e6c36a":"#e04a4a";

  // --- pixel + shape helpers (from play.html) ---
  function px(x,y,w,h,c){ g.fillStyle=c; g.fillRect(x|0,y|0,w|0,h|0); }
  function starPath(r){ g.beginPath(); for(let i=0;i<10;i++){ const an=Math.PI/5*i-Math.PI/2, rr=i%2?r*0.45:r; const X=Math.cos(an)*rr,Y=Math.sin(an)*rr; i?g.lineTo(X,Y):g.moveTo(X,Y);} g.closePath(); }
  function wheel(sx,sy,ang){ g.save(); g.translate(sx,sy); g.rotate(ang);
    g.fillStyle="#1a1216"; g.beginPath(); g.arc(0,0,3.4,0,6.29); g.fill();
    g.fillStyle="#4a3038"; g.beginPath(); g.arc(0,0,1.6,0,6.29); g.fill();
    g.strokeStyle="#6a4a52"; g.lineWidth=1; g.beginPath(); g.moveTo(-3,0); g.lineTo(3,0); g.moveTo(0,-3); g.lineTo(0,3); g.stroke(); g.restore(); }
  function rrect(x,y,w,h,r){ g.beginPath(); g.moveTo(x+r,y);
    g.arcTo(x+w,y,x+w,y+h,r); g.arcTo(x+w,y+h,x,y+h,r); g.arcTo(x,y+h,x,y,r); g.arcTo(x,y,x+w,y,r); g.closePath(); }

  // heroes (squads) — only `color` is read by drawTruck
  const heroById = {
    bug:  { color:"#c92b2b" }, feat: { color:"#2f7fd8" },
    docs: { color:"#159c9c" }, task: { color:"#d9a021" },
  };

  // ---- PLAYER / CREW ------------------------------------------------------- (drawGuy, play.html)
  function drawGuy(a){
    const f=a.face, bx=Math.round(a.x-camX), by=Math.round(a.y-camY);
    const P=a.pal, R=P.base, RD=P.dark, RL=P.light;
    const sq=a.squash>0?a.squash:0, st=(!a.onGround&&Math.abs(a.vy)>3)?0.12:0;
    const sw=1+sq*0.35-st, sh=1-sq*0.30+st, run=a.animT, step=Math.sin(run), air=!a.onGround&&!a.riding;
    g.save(); g.translate(bx,by); g.scale(f,1); g.scale(sw,sh);
    if(a.roll) g.rotate(a.roll);
    if(!(a.entering&&!a.onGround)){ g.globalAlpha=0.35; px(-6,-1,12,2,"#000"); g.globalAlpha=1; }
    const bH=9,bW=10,bt=-13;
    if(a.act==="kick"){ px(1,bt+bH-1,8,3,R); px(7,bt+bH-1,3,3,RL); px(-4,bt+bH-2,4,4,RD); }
    else if(air){ px(-4,bt+bH-1,4,4,RD); px(1,bt+bH-1,4,3,R); }
    else if(run>0){ const l1=step*3,l2=-step*3; px(-4,bt+bH-1,4,3+Math.max(0,l1),RD); px(1,bt+bH-1,4,3+Math.max(0,l2),R); }
    else { px(-4,bt+bH-1,4,4,RD); px(1,bt+bH-1,4,4,R); }
    px(-bW/2,bt,bW,bH,R); px(-bW/2,bt,1,bH,RD); px(bW/2-1,bt,1,bH,RD); px(-bW/2+1,bt,bW-2,1,RL);
    if(a.act==="punch"){ px(2,bt+2,8,3,R); px(9,bt+1,4,4,RL); px(-6,bt+3,3,3,RD); }
    else if(a.act==="kick"){ px(-6,bt+1,3,3,RD); px(4,bt+2,3,3,R); }
    else if(air){ px(-7,bt+1,3,4,RD); px(4,bt+1,3,4,R); }
    else if(run>0){ px(-6,bt+2-step*2,3,4,RD); px(3,bt+2+step*2,3,4,R); }
    else { px(-6,bt+3,3,4,RD); px(3,bt+3,3,4,R); }
    const fy=bt+2; px(0,fy,3,4,"#f5f0ee"); px(4,fy,3,4,"#f5f0ee");
    const lk=a.act!=="idle"?1:(Math.abs(a.vx)>0.5?1:0);
    px(1+lk,fy+1,1,2,"#101010"); px(5+lk,fy+1,1,2,"#101010"); px(0,fy-1,3,1,RD); px(4,fy-1,3,1,RD);
    if(a.act!=="idle") px(1,fy+5,5,2,"#2a0606"); else px(2,fy+5,3,1,"#2a0606");
    g.restore();
    if(a.act==="punch"&&a.actT>PUNCH_T-4){ g.globalAlpha=0.8; px(bx+f*13,by-11,2,2,"#fff"); g.globalAlpha=1; }
    if(a.act==="kick"&&a.actT>KICK_T-8){ g.globalAlpha=0.5; px(bx-f*10,by-8,6,6,"#ffe"); g.globalAlpha=1; }
    if(a.real||a.controlled){ g.font="7px 'Courier New',monospace"; g.textAlign="center";
      const tag=a.controlled?("> "+a.name):a.name, wpx=g.measureText(tag).width+4;
      px(bx-wpx/2,by-30,wpx,8,a.controlled?"#c92b2b":"rgba(0,0,0,0.55)"); g.fillStyle=a.controlled?"#fff":P.light; g.fillText(tag,bx,by-24); g.textAlign="left"; }
  }

  // ---- ISSUE TRUCK --------------------------------------------------------- (drawTruck, play.html)
  function drawTruck(o){
    if(!o.spawned||o.done) return;
    const sx=o.x-camX, gy=GROUND_Y-camY; if(sx<-120||sx>W+120) return;
    if(o.phase==="boom"){ const a=1-o.boomT/18; g.globalAlpha=a;
      g.fillStyle="#ffd76e"; g.beginPath(); g.arc(sx,gy-14,14*(0.5+o.boomT/12),0,6.29); g.fill();
      g.fillStyle="#e33"; g.beginPath(); g.arc(sx,gy-12,9*(0.5+o.boomT/14),0,6.29); g.fill(); g.globalAlpha=1; return; }
    if(o.boss){ g.globalAlpha=(o.fade??1); drawWarRig(sx, gy);
      if(o.phase==="battle"){ const p=Math.max(0,1-o.timer/o.dur), w=110;
        const bc=hpCol(p); px(sx-w/2,gy-42,w,4,"#2a141a"); px(sx-w/2,gy-42,w*p,4,bc); }
      g.fillStyle="#ffd24d"; g.font="7px 'Courier New',monospace"; g.textAlign="center"; g.fillText("BOSS #"+o.n, sx, gy-45); g.textAlign="left";
      g.globalAlpha=1; return; }
    const col=heroById[o.hero]?.color||"#c92b2b", colD=darken(col,0.6), colL=lighten(col,0.3);
    const bw=o.bw, bH=o.ch, cargoH=o.cargoH, bb=gy-3, bt=bb-bH;
    const unresolved=(o.phase==="pass"||o.phase==="out");
    g.globalAlpha=((o.phase==="pass")?0.9:1)*(o.fade??1);
    px(sx-bw/2,bt,bw,bH,"#3a2a30"); px(sx-bw/2,bt,bw,2,"#5a444c"); px(sx-bw/2,bb-2,bw,2,"#241a1e");
    const cabH=Math.round(cargoH*0.5)+2; px(sx+bw/2-9,bt-cabH,9,cabH,"#4a3038"); px(sx+bw/2-7,bt-cabH+2,5,3,"#8fb0c0");
    const cx=sx-bw/2, cw=bw-11, ct=bt-cargoH;
    px(cx,ct,cw,cargoH,col); px(cx,ct,cw,2,colL); px(cx,ct,2,cargoH,colL); px(cx+cw-2,ct,2,cargoH,colD); px(cx,ct+cargoH-2,cw,2,colD);
    g.fillStyle=lighten(col,0.6); g.font="7px 'Courier New',monospace"; g.textAlign="center"; g.fillText("#"+o.n,cx+cw/2,ct+cargoH/2+2.5); g.textAlign="left";
    wheel(sx-bw/2+6,bb,o.wheel); wheel(sx+bw/2-7,bb,o.wheel);
    if(o.phase==="battle"){ const p=Math.max(0,Math.min(1,o.hp!=null?o.hp:1)), w=bw-4;
      const col=hpCol(p); px(sx-w/2,ct-6,w,3,"#2a141a"); px(sx-w/2,ct-6,w*p,3,col); }
    if(unresolved){ px(sx-7,ct-8,14,7,"rgba(20,12,6,0.85)"); g.fillStyle="#e6c36a"; g.font="6px 'Courier New',monospace"; g.textAlign="center";
      g.fillText(o.hadRider?"OPEN":"—",sx,ct-2.5); g.textAlign="left"; }
    g.globalAlpha=1;
  }

  // ---- COMMIT STAR / BOT DRONE --------------------------------------------- (drawStar, play.html)
  function drawStar(s){ const x=s.x-camX,y=s.y-camY,a=Math.min(1,s.life/22); if(x<-30||x>W+30)return;
    if(s.bot){
      g.globalAlpha=a; const blade=(time%4<2)?3:1;
      px(x-7,y-2,3,1,"#2a3640"); px(x+4,y-2,3,1,"#2a3640");
      px(x-8,y-3,blade,1,"#cfe8ff"); px(x+8-blade,y-3,blade,1,"#cfe8ff");
      px(x-5,y-1,10,3,"#5a6b78"); px(x-2,y-3,4,3,"#7f93a3");
      px(x-1,y-1,2,1,(time%20<10)?"#e33":"#611"); g.globalAlpha=1;
    } else {
      g.save(); g.translate(x,y); g.rotate(s.spin); g.globalAlpha=a;
      g.fillStyle=s.color; starPath(4.2); g.fill(); g.fillStyle="#fff9d0"; starPath(1.8); g.fill(); g.restore(); g.globalAlpha=1;
    }
    if(s.sha){ g.globalAlpha=a*0.82; g.font="6px 'Courier New',monospace"; g.fillStyle=s.bot?"#9fe0ff":"#caa94f"; g.textAlign="left"; g.fillText(s.sha, x+(s.bot?8:6), y+2); g.globalAlpha=1; } }

  // ---- RESOLVED-ISSUE BALLOON ---------------------------------------------- (drawBalloon, play.html)
  function drawBalloon(b){ const x=Math.round(b.x), y=Math.round(b.y), s=Math.sin(b.sway);
    g.strokeStyle="#caa85a"; g.lineWidth=1; g.beginPath(); g.moveTo(x,y+7);
    g.quadraticCurveTo(x+s*4,y+14,x+Math.sin(b.sway+0.7)*3,y+22); g.stroke();
    g.fillStyle=b.color; g.beginPath(); g.ellipse(x,y,6,7,0,0,6.2832); g.fill();
    g.fillStyle=darken(b.color,0.7); g.beginPath(); g.moveTo(x-2,y+6); g.lineTo(x+2,y+6); g.lineTo(x,y+9); g.closePath(); g.fill();
    g.fillStyle="rgba(255,255,255,0.55)"; px(x-3,y-4,2,3);
    if(b.type){ g.font="bold 8px 'Courier New',monospace"; g.textAlign="left";
      g.fillStyle="#0b0b0b"; for(const d of [[-1,0],[1,0],[0,-1],[0,1]]) g.fillText(b.type,x+9+d[0],y+3+d[1]);
      g.fillStyle="#fff"; g.fillText(b.type,x+9,y+3); } }

  // ---- SQUASHED-BUG BUBBLE ------------------------------------------------- (drawBubble, play.html)
  function drawBubble(bb){ const x=Math.round(bb.x), y=Math.round(bb.y);
    g.globalAlpha=Math.min(1, bb.life/16);
    const w=22,h=16;
    g.fillStyle="#fff"; g.beginPath(); g.moveTo(x-3,y+h/2-2); g.lineTo(x+1,y+h/2+5); g.lineTo(x+4,y+h/2-2); g.closePath(); g.fill();
    rrect(x-w/2,y-h/2,w,h,4); g.fillStyle="#fff"; g.fill(); g.strokeStyle="#20242a"; g.lineWidth=1; g.stroke();
    g.fillStyle="#111"; g.strokeStyle="#111"; g.lineWidth=1;
    g.beginPath(); g.ellipse(x,y+1,3,4,0,0,6.2832); g.fill();
    g.beginPath(); g.ellipse(x,y-3.5,1.7,1.6,0,0,6.2832); g.fill();
    g.beginPath();
    g.moveTo(x-3,y);   g.lineTo(x-6,y-2);   g.moveTo(x-3,y+2); g.lineTo(x-6,y+3);
    g.moveTo(x+3,y);   g.lineTo(x+6,y-2);   g.moveTo(x+3,y+2); g.lineTo(x+6,y+3);
    g.moveTo(x-1,y-5); g.lineTo(x-3,y-7);   g.moveTo(x+1,y-5); g.lineTo(x+3,y-7);
    g.stroke();
    g.strokeStyle="#e0201b"; g.lineWidth=1.6;
    g.beginPath(); g.arc(x,y,7,0,6.2832); g.stroke();
    g.beginPath(); g.moveTo(x-5,y+5); g.lineTo(x+5,y-5); g.stroke();
    g.globalAlpha=1; }

  // ---- PR AIRPLANE --------------------------------------------------------- (drawPlane, play.html)
  function drawPlane(pl){
    const x=Math.round(pl.x), y=Math.round(pl.y);
    const col=pl.state==="merged"?"#5fbf6a":pl.state==="rejected"?"#d24a4a":"#9aa7b0", dk=darken(col,0.7);
    g.globalAlpha=0.16; for(let i=1;i<=6;i++) px(x-10-i*4,y-1,3,2,"#cfd6da"); g.globalAlpha=1;
    g.fillStyle=col; g.beginPath(); g.moveTo(x-9,y);   g.lineTo(x-13,y-6); g.lineTo(x-6,y); g.fill();
    px(x-8,y-1,16,4,"#e6ebed"); px(x-8,y-1,16,1,"#ffffff"); px(x-8,y+2,16,1,dk);
    g.fillStyle=col; g.beginPath(); g.moveTo(x+8,y-1); g.lineTo(x+14,y+1); g.lineTo(x+8,y+3); g.fill();
    g.fillStyle="#b8c0c6"; g.beginPath(); g.moveTo(x-1,y+1); g.lineTo(x-9,y+7); g.lineTo(x+2,y+3); g.fill();
    g.fillStyle="#cdd4d8"; g.beginPath(); g.moveTo(x-1,y+1); g.lineTo(x-8,y-5); g.lineTo(x+2,y-1); g.fill();
    px(x+3,y-1,3,2,"#39454f");
    px(x-4,y,7,1,col);
    g.fillStyle=col; g.font="6px 'Courier New',monospace"; g.textAlign="center"; g.fillText("#"+pl.n,x,y-8); g.textAlign="left";
  }

  // ---- MISSILE / REJECTED-PR BOMB ------------------------------------------ (drawMissile, play.html)
  function drawMissile(m){ const x=Math.round(m.x), y=Math.round(m.y);
    if(m.chute){
      g.fillStyle="#eef"; g.beginPath(); g.moveTo(x-7,y-2); g.quadraticCurveTo(x,y-11,x+7,y-2); g.closePath(); g.fill();
      px(x-7,y-2,14,1,"#cdd4e0");
      g.strokeStyle="#b8c0cc"; g.lineWidth=1; g.beginPath(); g.moveTo(x-6,y-1); g.lineTo(x,y+5); g.moveTo(x+6,y-1); g.lineTo(x,y+5); g.stroke();
      px(x-2,y+5,4,3,"#5cd06a");
      g.fillStyle="#cdd4e0"; g.font="6px 'Courier New',monospace"; g.textAlign="center"; g.fillText("#"+m.n,x,y-13); g.textAlign="left"; return; }
    g.globalAlpha=0.7; g.fillStyle="#ffcf7a"; px(x-3,y-1,3,2); px(x-5,y-1,2,1); g.globalAlpha=1;
    g.fillStyle=m.color; px(x-1,y-1,4,2); px(x+3,y-1,1,2); }

  // ---- THE VAULT / SAFE ---------------------------------------------------- (drawSafe, play.html; reads closure `safe`)
  function drawSafe(){ if(!safe || (safe.exploding && safe.boomT>6)) return;
    const x=safe.x-camX, gy=GROUND_Y-camY, w=44, h=48, rise=safe.rise||0, top=gy-h+rise; if(x<-60||x>W+60) return;
    const erupting=rise>0;
    if(erupting){ g.save(); g.beginPath(); g.rect(x-w/2-12, top-16, w+24, gy-(top-16)); g.clip(); }
    const j=(safe.exploding||erupting)?(Math.random()*2-1)*3:0;
    px(x-w/2+j,top,w,h,"#4a5058"); px(x-w/2+j,top,w,3,"#6b727a"); px(x-w/2+j,top,3,h,"#5a626a"); px(x+w/2-3+j,top,3,h,"#333a40"); px(x-w/2+j,top+h-3,w,3,"#2a2f34");
    px(x-w/2+5+j,top+5,w-10,h-10,"#3a4046"); px(x-w/2+5+j,top+5,w-10,2,"#525a62");
    g.fillStyle="#8a929a"; g.beginPath(); g.arc(x+j,top+h*0.55,7,0,6.29); g.fill(); g.fillStyle="#2a2f34"; g.beginPath(); g.arc(x+j,top+h*0.55,4,0,6.29); g.fill();
    g.strokeStyle="#cdd4d8"; g.lineWidth=1; g.beginPath(); g.moveTo(x+j,top+h*0.55); g.lineTo(x+j+Math.cos(safe.t*0.2)*5,top+h*0.55+Math.sin(safe.t*0.2)*5); g.stroke();
    px(x+w/2-9+j,top+h*0.55-1,6,2,"#8a929a");
    g.fillStyle="#d9b84a"; g.font="11px 'Courier New',monospace"; g.textAlign="center"; g.fillText("$",x+j,top+16); g.textAlign="left";
    if(erupting){ g.restore(); return; }
    const p=Math.max(0,1-safe.t/safe.dur); px(x-w/2,top-8,w,4,"#2a141a"); px(x-w/2,top-8,w*p,4,"#8fd8a0"); }

  // ---- BOSS WAR-RIG -------------------------------------------------------- (drawWarRig, play.html)
  function drawWarRig(sx, gy){
    const CHR="#c8ccd0",CHRM="#9aa0a6",CHRD="#6a7076",GUN="#4a4e54",GUNH="#8a9098",GUNM="#6a7078",GUND="#2e3238",GUNDD="#20242a";
    const BODY="#5a5e64",BODYH="#7a7e84",BODYD="#34383e",TIRE="#0e0a0c",RIM="#d8d4c8",HUB="#7a4028",HUBH="#9a5836";
    const FRAME="#241a16",RUST="#6a3a20",TAN="#8a6038",OLIVE="#3a3a2a",RED="#8c1010",REDH="#c02020",WHT="#efeee6",WHD="#cfcfc7";
    const tank=(x0,x1,cy,r)=>{ const w=x1-x0,top=cy-r,bot=cy+r;
      px(x0,top,w,r*2,GUN); px(x0,top,w,2,GUNH); px(x0,top+2,w,1,GUNM);
      for(let yy=cy+1;yy<bot;yy++)for(let xx=x0;xx<x1;xx++)if(((xx+yy)&1)===0)px(xx,yy,1,1,GUND);
      px(x0,bot-1,w,1,GUNDD); px(x0,top,1,r*2,GUND); px(x1-1,top,1,r*2,GUND);
      px(x0+(w*0.25|0),top,1,r*2,GUNM); px(x0+(w*0.5|0),top,1,r*2,GUNM); px(x0+(w*0.75|0),top,1,r*2,GUNM);
      px(x0+2,top-2,w-4,1,GUND); px(x0+2,top-1,w-4,1,CHRM); for(let xx=x0+4;xx<x1-2;xx+=4)px(xx,top-2,1,1,CHR); };
    const camo=(x,y,c)=>{ px(x,y,4,3,c);px(x+3,y+2,3,2,c);px(x-2,y+1,3,2,c);px(x+1,y-1,2,2,c); };
    const chain=(x,y)=>{ for(let i=0;i<13;i++){const a=x+i*3,b=y+Math.round(Math.sin(i*0.85)*2.2);px(a,b,2,1,CHRD);px(a,b,1,1,CHRM);} };
    const spk=(x,y)=>{ px(x,y-1,5,1,GUND);px(x+1,y-2,3,1,GUNM);px(x+2,y-3,1,1,CHRM); };
    const spkR=(x,y)=>{ px(x,y-2,1,5,GUND);px(x+1,y-1,1,3,GUNM);px(x+2,y,1,1,CHRM); };
    const flm=(x,y)=>{ const f=(time+x*3)%6<3?0:1; px(x-1,y-1,3,1,"#ff5a2a");px(x-1,y-4,3,3,"#ff3a1a");px(x,y-8-f,2,4,"#ff9a3d");px(x,y-12-f,1,3,"#ffd24d"); };
    const smk=(x,y)=>{ px(x-2,y,4,3,"rgba(44,40,44,0.7)");px(x-1,y-3,3,3,"rgba(64,60,64,0.5)");px(x,y-6,2,2,"rgba(88,84,88,0.35)"); };
    const flag=(x,h)=>{ const wv=(time>>3)%2?4:3; px(x,gy-h,1,h,CHRD); px(x-wv,gy-h,wv,2,"#a02020"); px(x-wv,gy-h+1,wv,1,"#c8402e"); };
    const turret=(x)=>{ px(x-4,gy-31,8,7,"#33332c");px(x-4,gy-31,8,1,"#50504a");px(x-3,gy-30,2,2,"#20201a"); flag(x,40); };
    const skull=(x,y)=>{ px(x-7,y-6,15,13,"#160c12");
      for(let i=-6;i<=6;i++){const t=Math.round(i*0.7);px(x+i,y+t,1,1,WHD);px(x+i,y-t,1,1,WHD);}
      px(x-7,y-5,2,2,WHT);px(x+6,y-5,2,2,WHT);px(x-7,y+4,2,2,WHT);px(x+6,y+4,2,2,WHT);
      px(x-3,y-5,6,5,"#e8e8e0");px(x-3,y-5,6,1,"#fff");
      px(x-2,y-3,2,2,"#160c12");px(x+1,y-3,2,2,"#160c12");px(x,y-1,1,1,"#160c12");
      px(x-3,y,6,1,"#c4c4bc");px(x-2,y+1,1,1,"#e8e8e0");px(x,y+1,1,1,"#e8e8e0");px(x+2,y+1,1,1,"#e8e8e0"); };
    const rw=(x)=>{ px(x-6,gy-8,12,10,TIRE);px(x-6,gy-8,12,1,"#241a1e");
      for(let i=0;i<6;i++)px(x-6+i*2,gy-8,1,2,"#040406");
      px(x-3,gy-5,6,5,RIM);px(x-3,gy-5,6,1,"#efeee6");px(x-2,gy-3,4,2,HUB);px(x-1,gy-3,2,1,HUBH); };

    const TL=66, t1a=sx-90, t1b=t1a+TL, t2a=t1b+6, t2b=t2a+TL, cbL=t2b+6, cbR=cbL+18;
    px(t1a-6, gy-7, (cbR+2)-(t1a-6), 4, FRAME); px(t1a-6, gy-6, 50, 2, "#3a241a");
    [t1a+12,t1a+34,t1a+56, t2a+12,t2a+34,t2a+56, cbL+3,cbL+13].forEach(rw);
    tank(t1a,t1b,gy-16,8); camo(t1a+16,gy-19,RUST); camo(t1a+40,gy-14,OLIVE); camo(t1a+56,gy-20,TAN);
    chain(t1a+8,gy-9); turret(t1a+18); flag(t1a+34,30);
    px(t1a-5,gy-15,5,9,FRAME); spk(t1a-4,gy-23); spkR(t1a-6,gy-12); skull(t1a+42,gy-15);
    for(let x=t1a+6;x<t1b-4;x+=11) spk(x,gy-24);
    tank(t2a,t2b,gy-16,8); camo(t2a+16,gy-19,RUST); camo(t2a+40,gy-20,OLIVE); camo(t2a+56,gy-14,TAN);
    chain(t2a+8,gy-9); skull(t2a+33,gy-15);
    px(t1b,gy-12,6,4,FRAME); px(t2b,gy-12,6,4,FRAME);
    for(let x=t2a+6;x<t2b-4;x+=11) spk(x,gy-24); spkR(t2b,gy-13); spkR(t2b,gy-19);
    for(let k=0;k<3;k++){const xx=cbL-1+k*3; px(xx,gy-30,2,18,CHRD);px(xx,gy-30,1,18,CHR);px(xx-1,gy-31,3,1,CHR);}
    smk(cbL,gy-36); smk(cbL+4,gy-35); flm(cbL,gy-30); flm(cbL+4,gy-30);
    px(cbL,gy-27,cbR-cbL,23,BODY); px(cbL,gy-27,cbR-cbL,2,BODYH); px(cbR-1,gy-27,1,23,BODYD);
    px(cbR-8,gy-25,7,8,"#2f4a56"); px(cbR-8,gy-25,7,1,"#5a808e");
    const bm=cbR; px(bm,gy-14,8,11,RED); px(bm,gy-14,8,1,REDH); px(bm,gy-4,8,1,"#5a0808");
    for(let t=0;t<4;t++){const x=bm+t*2; px(x,gy-14,2,3,WHT); px(x+1,gy-11,1,1,WHD);}
    for(let t=0;t<4;t++){const x=bm+t*2; px(x,gy-7,2,3,WHT); px(x,gy-9,1,1,WHD);}
    px(bm+8,gy-13,3,9,RED); px(bm+8,gy-13,1,3,WHT); px(bm+8,gy-6,1,3,WHT); px(bm+10,gy-10,1,3,WHT);
    px(cbR-3,gy-24,3,3,"#f0f0e8"); px(cbR-2,gy-23,1,2,"#101010");
  }

  // ---- FALLEN-DEV GHOST ---------------------------------------------------- (inline in play.html render loop)
  function drawGhost(gh){ const x=gh.x+Math.sin(gh.sway)*3, y=gh.y, al=Math.min(0.75,gh.life/50); g.globalAlpha=al;
    g.fillStyle="#eaf2f7"; g.beginPath(); g.arc(x,y,4,Math.PI,0); g.lineTo(x+4,y+4); g.lineTo(x+2,y+2); g.lineTo(x,y+4); g.lineTo(x-2,y+2); g.lineTo(x-4,y+4); g.closePath(); g.fill();
    g.fillStyle="#2a2f34"; px(x-2,y-1,1,1); px(x+1,y-1,1,1); g.globalAlpha=1; }

  // ============================================================================
  //  Field-guide cards — each renders one sprite into its own mini canvas.
  //  `groundY` (px from top) present => the sprite is ground-anchored and a
  //  ground line is drawn; absent => the sprite is screen-anchored (camX/Y = 0).
  // ============================================================================
  const SP = '<span class="sp">Spawns:</span> ', LV = '<span class="lv">Leaves:</span> ';
  const CARDS = [
    { title:"The Crew", chip:"YOUR SQUAD", chipCol:"#e0524e", backW:60, backH:62, scale:3.2, groundY:52,
      draw(){ drawGuy({ x:W/2, y:GROUND_Y, face:1, pal:palette("#e0524e"), squash:0, onGround:true, vy:0,
        animT:time*0.35, act:"idle", actT:0, roll:0, entering:false, riding:null, real:false, controlled:false, vx:1, name:"" }); },
      body:`The little runners are your crew — one per active squad (Bug, Feature, Docs, Chores), colored to match.
        The biggest squad's runner is the one <b>you</b> drive. The base crew is immortal.<br>
        ${SP}at the start, in a random grand entrance (UFO drop, transporter beam, or portal). Extra crew paradrop in from merged PRs.<br>
        ${LV}the base crew never die; paradropped devs can be killed (see <b>Ghost</b>). Everyone finishes at the vault.` },

    { title:"Issue Truck", chip:"ISSUE", chipCol:"#e0524e", backW:118, backH:78, scale:2.7, groundY:62,
      draw(){ drawTruck({ spawned:true, done:false, x:W/2, phase:"battle", boss:false, hero:"bug",
        bw:40, ch:12, cargoH:15, wheel:time*0.14, n:42, fade:1, hp:0.55, hadRider:false }); },
      body:`Every issue is a truck. Its cargo box shows the issue <b>#</b>, tinted by squad (from labels + title); more comments make a bigger rig.<br>
        ${SP}on the date the issue was opened.<br>
        ${LV}a <b>closed</b> issue is battled until it <b>explodes</b> (resolved) — the fight lasts as long as the issue stayed open.
        A worked-on <b>open</b> issue is battled, then the rider hops off (still OPEN). An untouched open issue just rolls past.` },

    { title:"The Boss", chip:"TOP ISSUE", chipCol:"#ffd24d", backW:208, backH:82, scale:2.15, groundY:62, wide:true,
      draw(){ drawWarRig(W/2+6, 62); },
      body:`The most-discussed issue becomes the boss: a Mad-Max road train fought in slow-motion. It's picked at random from the
        two hottest <b>open</b> and two hottest <b>closed</b> issues, so who shows up — and how it ends — changes every run.<br>
        ${SP}on its own open date, jumping the queue so it's never late.<br>
        ${LV}if the boss issue is <b>closed</b>, the rig is destroyed; if it's still <b>open</b>, it <b>flees</b>.` },

    { title:"Commit Star", chip:"COMMIT", chipCol:"#f5d76e", backW:120, backH:52, scale:3,
      draw(){ drawStar({ x:W*0.30, y:H*0.5, life:30, bot:false, spin:time*0.05, color:"#f5d76e", sha:"a1c0de" });
              drawStar({ x:W*0.74, y:H*0.5, life:30, bot:true, spin:0, sha:"" }); },
      body:`Each commit flings a gold star off the front runner, stamped with its short SHA. Commits from bots
        (dependabot, renovate, CI) fly as little <b>drones</b> instead (right).<br>
        ${SP}at the commit's date, in a steady shower.<br>
        ${LV}arcs up, lives about a second, and fades out.` },

    { title:"PR Airplane", chip:"PULL REQUEST", chipCol:"#5fbf6a", backW:64, backH:50, scale:3.2,
      draw(){ drawPlane({ x:W/2, y:H*0.46, state:"merged", n:112 }); },
      body:`Every pull request flies in from the left as an airplane marked with its <b>#</b>. Its color is its fate:
        <b class="sp">green = merged</b>, <b>grey = still open</b>, <b class="lv">red = rejected</b>.<br>
        ${SP}on the PR's created date.<br>
        ${LV}merged drops a white parachute (a commit-star — or a whole new dev) then peels off; open flies past; rejected drops a bomb and blows up.` },

    { title:"Rejected-PR Bomb", chip:"REJECTED PR", chipCol:"#d24a4a", backW:36, backH:34, scale:5,
      draw(){ drawMissile({ x:W/2, y:H*0.44, color:"#ff5a4a" }); },
      body:`A rejected PR's red plane lobs this bomb just before it explodes.<br>
        ${SP}when a red (rejected) plane reaches its target.<br>
        ${LV}detonates on the ground — mortal devs in the blast die (→ <b>ghosts</b>); the immortal core just get thrown.` },

    { title:"Resolved Balloon", chip:"RESOLVED ISSUE", chipCol:"#6ab0ff", backW:96, backH:66, scale:3,
      draw(){ drawBalloon({ x:W*0.34, y:H*0.40, sway:time*0.05, color:"#6ab0ff", type:"Feature" }); },
      body:`When a <b>non-bug</b> issue is resolved, a squad-colored balloon floats up out of the wreck carrying the issue's title.<br>
        ${SP}the moment a feature / docs / chore issue is closed.<br>
        ${LV}rises and drifts on the breeze, then fades.` },

    { title:"Squashed-Bug Bubble", chip:"KILLED BUG", chipCol:"#e0201b", backW:56, backH:54, scale:3.4,
      draw(){ drawBubble({ x:W/2, y:H*0.46, life:66 }); },
      body:`Only a killed <b>bug</b> issue pops this — a white speech bubble with a crossed-out beetle. The bug is squashed.<br>
        ${SP}when a bug-labeled issue is resolved.<br>
        ${LV}hangs over the wreck and fades out in about a second.` },

    { title:"Fallen-Dev Ghost", chip:"CASUALTY", chipCol:"#eaf2f7", backW:52, backH:56, scale:3.4,
      draw(){ drawGhost({ x:W/2, y:H*0.52, sway:time*0.06, life:120, name:"" }); },
      body:`When a mortal crew member is killed, they burst and a little ghost drifts up wearing their name — permadeath, gone for the rest of the run.<br>
        ${SP}when a paradropped dev is caught by a rejected-PR bomb or a boss blast.<br>
        ${LV}floats upward, swaying, and fades away.` },

    { title:"The Vault", chip:"THE FINISH", chipCol:"#8fd8a0", backW:64, backH:80, scale:2.8, groundY:66,
      draw(){ safe = { x:W/2, t:time, dur:100000, exploding:false, boomT:0, rise:0 }; drawSafe(); },
      body:`The finish line. Once the timeline runs out, a vault heaves up out of the ground for the crew to crack. The green bar is its integrity.<br>
        ${SP}after the last event in your date range.<br>
        ${LV}the crew blow it open → <b class="sp">LEVEL COMPLETE</b>.` },
  ];

  // --- build the DOM into #field-guide ---
  const grid = document.createElement("div"); grid.className = "fg-grid"; container.appendChild(grid);
  for(const c of CARDS){
    const fig = document.createElement("figure"); fig.className = "card" + (c.wide ? " wide" : "");
    const scr = document.createElement("div"); scr.className = "screen";
    const cv = document.createElement("canvas"); cv.width = c.backW; cv.height = c.backH;
    cv.style.width = (c.backW*c.scale)+"px"; cv.style.height = (c.backH*c.scale)+"px";
    c.cv = cv; scr.appendChild(cv); fig.appendChild(scr);
    const head = document.createElement("div"); head.className = "head";
    const h = document.createElement("h3"); h.textContent = c.title;
    const chip = document.createElement("span"); chip.className = "chip"; chip.textContent = c.chip; chip.style.color = c.chipCol || "#c7b3b8";
    head.appendChild(h); head.appendChild(chip); fig.appendChild(head);
    const p = document.createElement("p"); p.innerHTML = c.body; fig.appendChild(p);
    grid.appendChild(fig);
  }

  // --- point the globals at one card's canvas, then it's ready to draw ---
  function use(c){
    const cv = c.cv; g = cv.getContext("2d"); W = cv.width; H = cv.height;
    camX = 0; camY = (c.groundY != null) ? GROUND_Y - c.groundY : 0;
    g.setTransform(1,0,0,1,0,0); g.globalAlpha = 1; g.textAlign = "left"; g.imageSmoothingEnabled = false;
    g.clearRect(0,0,W,H);
    if(c.groundY != null){ px(0, c.groundY, W, H - c.groundY, "#181016"); px(0, c.groundY, W, 1, "#3a2630"); }
  }

  // --- one shared loop drives every card so the sprites animate like they do in-game.
  //     Skips the actual draw work while the container is hidden (e.g. an inactive tab). ---
  function frame(){ time++; if(container.offsetParent !== null){ for(const c of CARDS){ use(c); c.draw(); } } requestAnimationFrame(frame); }
  requestAnimationFrame(frame);
})();
