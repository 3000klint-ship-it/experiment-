
require('dotenv').config();
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const WebSocket = require("ws");

const app = express();
const PORT = Number(process.env.PORT || 3000);
app.use(express.static(path.join(__dirname, "public")));

app.get("/avatars",(req,res)=>{
  fs.readdir(path.join(__dirname,"public"),(err,files)=>{
    if(err) return res.json([]);
    const avs=files.filter(f=>/\.(jpe?g|png|webp|gif)$/i.test(f)).sort();
    res.json(avs);
  });
});

app.get("/gif-search",async (req,res)=>{
  const key=process.env.GIPHY_KEY;
  if(!key) return res.json({results:[],needsKey:true});
  const q=(req.query.q||"").toString().slice(0,60).trim();
  const url= q
      ? "https://api.giphy.com/v1/gifs/search?api_key="+encodeURIComponent(key)+"&q="+encodeURIComponent(q)+"&limit=24&rating=g"
      : "https://api.giphy.com/v1/gifs/trending?api_key="+encodeURIComponent(key)+"&limit=24&rating=g";
  try{
    const r=await fetch(url);const j=await r.json();
    const img=g=>g.images.fixed_width;
    const out=(j.data||[]).map(g=>({url:img(g).url,width:img(g).width,height:img(g).height}));
    res.json({results:out});
  }catch(e){ res.json({results:[]}); }
});

// GIF proxy with server-side caching: once one player loads a GIF, the file is
// served from this server for everyone else, so there is no repeated download lag.
const httpProxy = require("http"), httpsProxy = require("https");
const gifCache = new Map(); // url -> {buffer, type, expires}
const gifInflight = new Map(); // url -> Promise resolved when fetched
const GIF_CACHE_MAX = 60;    // keep up to 60 GIFs in memory
function fetchGif(target){
  // Return a promise that resolves to {buffer,type} or rejects. Concurrent
  // callers for the same URL share one upstream download (no thundering herd).
  if(gifInflight.has(target)) return gifInflight.get(target);
  const p=new Promise((resolve,reject)=>{
    const lib=target.startsWith("https:")?httpsProxy:httpProxy;
    lib.get(target,(up)=>{
      if(up.statusCode>=400){ up.resume(); reject(new Error("gif error")); return; }
      const type=up.headers["content-type"]||"image/gif";
      const chunks=[]; let size=0;
      up.on("data",c=>{ if(size<8*1024*1024){chunks.push(c);size+=c.length;} else { up.destroy(); reject(new Error("too big")); } });
      up.on("end",()=>{ resolve({buffer:Buffer.concat(chunks),type}); });
      up.on("error",reject);
    }).on("error",reject);
  }).then(data=>{
    const expires=Date.now()+24*60*60*1000;
    if(gifCache.size>=GIF_CACHE_MAX){ const first=gifCache.keys().next().value; if(first) gifCache.delete(first); }
    gifCache.set(target,{buffer:data.buffer,type:data.type,expires});
    return data;
  }).finally(()=>gifInflight.delete(target));
  gifInflight.set(target,p);
  return p;
}
app.get("/gif-proxy",(req,res)=>{
  const target=String(req.query.url||"");
  if(!/^https:\/\/media[0-9]+\.giphy\.com\//.test(target)) return res.status(400).end("bad url");
  const cached=gifCache.get(target);
  if(cached && cached.expires>Date.now()){
    res.set("Content-Type",cached.type);
    res.set("Cache-Control","public, max-age=86400");
    res.send(cached.buffer);
    return;
  }
  fetchGif(target).then(({buffer,type})=>{
    res.set("Content-Type",type);
    res.set("Cache-Control","public, max-age=86400");
    res.send(buffer);
  }).catch(()=>{ if(!res.headersSent) res.status(502).end("gif error"); });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const COLORS = ["red","yellow","green","blue"];
const TYPES = ["number","skip","reverse","draw2","wild","wild4"];
const TURN_MS = 20000;

function id(){ return crypto.randomBytes(8).toString("hex"); }

// Single shared lounge: no join codes. Everyone who connects lands here.
const ROOM = { code:"LOUNGE", hostId:null, maxPlayers:8, minCards:10, maxCards:30, players:[], game:null };
let countdownTimer = null;

function makeDeck(){
  const d=[]; let n=0;
  for(const color of COLORS){
    d.push({id:"c"+(++n),color,type:"number",value:0});
    for(let v=1;v<=9;v++) for(let k=0;k<2;k++) d.push({id:"c"+(++n),color,type:"number",value:v});
    for(const type of ["skip","reverse","draw2"]) for(let k=0;k<2;k++) d.push({id:"c"+(++n),color,type});
  }
  for(let k=0;k<4;k++) d.push({id:"c"+(++n),color:"wild",type:"wild"});
  for(let k=0;k<4;k++) d.push({id:"c"+(++n),color:"wild",type:"wild4"});
  return d;
}
function shuffle(a){ for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }

function safeRoom(r){
  return {
    code:r.code, hostId:r.hostId, maxPlayers:r.maxPlayers,
    minCards:r.minCards, maxCards:r.maxCards,
    players:r.players.map(p=>({id:p.id,username:p.username,avatar:p.avatar,host:p.id===r.hostId,connected:!!p.ws,ready:!!p.ready,away:!!p.away,spectating:!!p.spectating}))
  };
}
function broadcast(r,msg){
  const s=JSON.stringify(msg);
  for(const p of r.players) if(p.ws && p.ws.readyState===WebSocket.OPEN) p.ws.send(s);
}
function broadcastState(r){
  const base=safeRoom(r);
  for(const p of r.players){
    if(!p.ws || p.ws.readyState!==WebSocket.OPEN) continue;
    const me = r.game ? r.game.players.find(x=>x.id===p.id) : null;
    const game=r.game ? {
      players:r.game.players.map(x=>({
        id:x.id,username:x.username,avatar:x.avatar,seat:x.seat,handCount:x.hand.length,
        calledUno:x.calledUno,connected:!!r.players.find(q=>q.id===x.id)?.ws,
        finished:!!x.finished,away:!!x.away,spectating:!!x.spectating
      })),
      turn:r.game.turn,discard:r.game.discard,currentColor:r.game.currentColor,
      turnStartedAt:r.game.turnStartedAt,turnMs:TURN_MS,
      drawStack:r.game.drawStack,winner:r.game.winner||null,
      hand:(me&&!me.spectating)?me.hand:[],
      rankings:r.game.rankings||[],direction:r.game.direction||1,isOver:!!r.game.isOver,
      reshuffled:!!r.game.reshuffled
    } : null;
    p.ws.send(JSON.stringify({type:"state",room:base,game}));
  }
}
function playerOf(r,id){ return r.players.find(p=>p.id===id); }
function gamePlayer(r,id){ return r.game?.players.find(p=>p.id===id); }
function removePlayerCompletely(r,id){
  r.players=r.players.filter(p=>p.id!==id);
  const g=r.game;
  if(g && !g.isOver){
    const idx=g.players.findIndex(x=>x.id===id);
    if(idx!==-1){
      g.players.splice(idx,1);
      if(g.turn>idx) g.turn--;
      else if(g.turn===idx) g.turn=g.players.length?g.turn%g.players.length:0;
      if(g.turn>=g.players.length) g.turn=0;
      if(g.players.length){
        let guard=0;
        while(g.players[g.turn] && g.players[g.turn].finished && guard++<g.players.length) g.turn=(g.turn+g.direction+g.players.length)%g.players.length;
        g.turnStartedAt=Date.now();
      }
    }
  }
}

function drawCards(r,g, gp, count){
  let drawn=0;
  while(drawn<count && gp.hand.length<r.maxCards){
    if(!g.deck.length){
      const refill=g.discardPile || [];
      g.deck=shuffle(refill.splice(0));
      g.discardPile=[];
    }
    if(!g.deck.length){
      const alt=makeDeck();
      shuffle(alt);
      g.deck=alt;
    }
    if(!g.deck.length) break;
    gp.hand.push(g.deck.pop()); drawn++;
  }
  console.log("[drawCards] target:",gp.username,"requested:",count,"drawn:",drawn,"hand:",gp.hand.length);
  return drawn;
}

// When a draw penalty (+2 / +4) is pending, the next player may defend:
//  - any +2 or +4 card stacks onto the penalty
//  - a Skip or Reverse of the CURRENT colour passes the penalty to another
//    player (house rule) instead of cancelling it
// Plain Wild and number cards are NOT valid defences.
function canPlay(g,c){
  if(g.drawStack>0){
    if(c.type==="draw2"||c.type==="wild4") return true;
    if((c.type==="skip"||c.type==="reverse") && c.color===g.currentColor) return true;
    return false;
  }
  const top=g.discard;
  if(c.type==="wild" || c.type==="wild4") return true;
  return c.color===g.currentColor ||
    (c.type==="number" && top.type==="number" && c.value===top.value) ||
    (c.type!=="number" && c.type===top.type);
}
function nextSeat(g,steps=1){
  let s=g.turn;
  const n=g.players.length;
  for(let i=0;i<steps;i++) s=(s+g.direction+n)%n;
  return s;
}
function advance(g,steps=1){
  let s=nextSeat(g,steps);
  const n=g.players.length;
  let maxIter=n;
  while(g.players[s] && (g.players[s].finished||g.players[s].away||g.players[s].spectating) && maxIter-->0) s=(s+g.direction+n)%n;
  g.turn=s;
  g.reshuffled=false;
  g.turnStartedAt=Date.now();
}

function startGame(r){
  if(r.players.length<2) throw Error("Need at least 2 players.");
  const deck=shuffle(makeDeck());
  const gps=r.players.map((p,i)=>({id:p.id,username:p.username,avatar:p.avatar,seat:i,hand:[],calledUno:false,finished:false,away:!!p.away,spectating:!!p.spectating}));
  const g={players:gps,deck,discardPile:[],discard:null,currentColor:null,turn:0,drawStack:0,winner:null,direction:1,rankings:[],isOver:false,reshuffled:false};
  for(const gp of gps) drawCards(r,g,gp,r.minCards);

  // Start with a non-wild card so the first color is clear.
  while(true){
    const c=g.deck.pop();
    if(c && c.color!=="wild"){ g.discard=c; g.currentColor=c.color; break; }
    if(c) g.discardPile.push(c);
  }
  r.game=g;
  g.turnStartedAt=Date.now();
  for(const p of r.players) p.ready=false;
  let guard=g.players.length;
  while(guard-->0 && (g.players[g.turn].away||g.players[g.turn].spectating)) advance(g,1);
  broadcast(r,{type:"started"});
  broadcastState(r);
}

function finalizeIfDone(r){
  const g=r.game; if(!g||g.isOver) return false;
  const active=g.players.filter(p=>!p.finished && !p.away);
  if(active.length<=1){
    if(active.length===1){
      const a=active[0]; a.finished=true; a.hand=[]; a.calledUno=false;
      g.rankings.push({id:a.id,username:a.username,rank:g.rankings.length+1});
    }
    // Any remaining non-finished players (e.g. disconnected/away) ranked by cards left.
    const rest=g.players.filter(p=>!p.finished).sort((x,y)=>x.hand.length-y.hand.length);
    rest.forEach(p=>{ if(!p.finished){ p.finished=true; g.rankings.push({id:p.id,username:p.username,rank:g.rankings.length+1}); } });
    g.isOver=true; g.winner=g.rankings[0]?g.rankings[0].id:null;
    broadcast(r,{type:"sound",name:"card"});
    broadcast(r,{type:"gameFinished",rankings:g.rankings});
    r.game=null;
    for(const pl of r.players) pl.ready=false;
    broadcastState(r); updateReadyState(r);
    return true;
  }
  return false;
}
function handlePlay(r,p,msg){
  const g=r.game, gp=gamePlayer(r,p.id);
  if(!g||g.isOver) return;
  if(gp.finished) return;
  if(g.players[g.turn]?.id!==p.id) return;
  const idx=gp.hand.findIndex(c=>c.id===msg.cardId);
  if(idx<0) return;
  const c=gp.hand[idx];
  if(!canPlay(g,c)) return;
  if((c.type==="wild"||c.type==="wild4") && !COLORS.includes(msg.color)) return;
  const hadPenalty=g.drawStack>0;

  gp.hand.splice(idx,1);
  g.discardPile.push(g.discard);
  g.discard=c;
  const n=g.players.length;
  g.currentColor=(c.type==="wild"||c.type==="wild4")?msg.color:c.color;
  let steps=1;
  if(c.type==="draw2") g.drawStack = hadPenalty ? g.drawStack+2 : 2;
  else if(c.type==="wild4") g.drawStack = hadPenalty ? g.drawStack+4 : 4;
  else if(c.type==="reverse"){
    g.direction*=-1;
    steps = (n===2 && !hadPenalty) ? 2 : 1;
  }
  else if(c.type==="skip"){ steps = (n===2 && hadPenalty) ? 1 : 2; } // matching colour: stack passed on, not cancelled
  else { g.drawStack=0; }

  if(gp.hand.length===0){
    gp.finished=true;
    gp.calledUno=false;
    g.rankings.push({id:gp.id,username:gp.username,rank:g.rankings.length+1});
    broadcast(r,{type:"playerFinished",username:gp.username,rank:g.rankings.length});
    if(!finalizeIfDone(r)){ advance(g,steps); broadcast(r,{type:"sound",name:"card"}); broadcastState(r); }
    return;
  }

  if(gp.hand.length===1) gp.calledUno=false;
  if(gp.hand.length>1) gp.calledUno=false;

  advance(g,steps);
  broadcast(r,{type:"sound",name:"card"});
  broadcastState(r);
}
function handleDraw(r,p){
  const g=r.game,gp=gamePlayer(r,p.id);
  if(!g||g.isOver||gp.finished||g.players[g.turn]?.id!==p.id) return;
  const count=g.drawStack>0?g.drawStack:1;
  g.drawStack=0;
  drawCards(r,g,gp,count);
  advance(g,1);
  broadcast(r,{type:"sound",name:"draw"});
  broadcastState(r);
}

// Ready / auto-start (5 second countdown) mechanism.
function startCountdown(r){
  if(countdownTimer) return;
  let remaining=5;
  broadcast(r,{type:"countdown",seconds:remaining});
  countdownTimer=setInterval(()=>{
    remaining--;
    if(remaining<=0){
      clearInterval(countdownTimer);countdownTimer=null;
      try{ startGame(r); }
      catch(e){ broadcast(r,{type:"error",message:e.message}); }
      return;
    }
    broadcast(r,{type:"countdown",seconds:remaining});
  },1000);
}
function cancelCountdown(r){
  if(countdownTimer){clearInterval(countdownTimer);countdownTimer=null;broadcast(r,{type:"countdownCancel"});}
}
function updateReadyState(r){
  if(countdownTimer){
    if(r.players.length>=2 && r.players.every(p=>p.ready)) return;
    cancelCountdown(r); return;
  }
  if(r.players.length>=2 && r.players.every(p=>p.ready) && (!r.game || r.game.isOver)) startCountdown(r);
}

wss.on("connection", ws=>{
  const clientId=id();
  ws.send(JSON.stringify({type:"hello",id:clientId}));

  ws.on("message", raw=>{
    let m; try{m=JSON.parse(raw);}catch{return;}
    try{
      if(m.type==="join"){
        const username=String(m.username||"").trim().slice(0,18);
        const avatar=m.avatar||"avatar1.jpg";
        if(!username) throw Error("Enter a username.");
        if(ROOM.players.length>=ROOM.maxPlayers) throw Error("Lounge is full.");
        const gameActive = ROOM.game && !ROOM.game.isOver;
        if(gameActive){
          // Reconnect a disconnected player with the same username instead of refusing.
          const ghost = ROOM.players.find(p=>!p.ws && p.username===username);
          if(ghost){
            const oldId=ghost.id;
            ghost.id=clientId; ghost.ws=ws; ghost.avatar=avatar; ghost.ready=false;
            ghost.away=true; ghost.spectating=false; // decide via Resume/Spectate
            if(ROOM.game){
              for(const gp of ROOM.game.players) if(gp.id===oldId) gp.id=clientId;
              for(const rk of ROOM.game.rankings) if(rk.id===oldId) rk.id=clientId;
              // don't stall the game while they decide
              if(ROOM.game.players[ROOM.game.turn]?.id===clientId) advance(ROOM.game,1);
            }
            if(ROOM.hostId===oldId) ROOM.hostId=clientId;
            ws.send(JSON.stringify({type:"joined",code:ROOM.code}));
            ws.send(JSON.stringify({type:"rejoinChoice"}));
            broadcastState(ROOM); return;
          }
          // New player joining mid-game: become a spectator (watch + chat)
          if(!ROOM.hostId || !ROOM.players.some(x=>x.id===ROOM.hostId&&x.ws)) ROOM.hostId=clientId;
          const p={id:clientId,username,ws,avatar:avatar,ready:false,away:true,spectating:true};
          ROOM.players.push(p);
          ws.send(JSON.stringify({type:"joined",code:ROOM.code}));
          broadcastState(ROOM); return;
        }
        if(!ROOM.hostId || !ROOM.players.some(x=>x.id===ROOM.hostId&&x.ws)) ROOM.hostId=clientId;
        const p={id:clientId,username,ws,avatar:avatar,ready:false};
        ROOM.players.push(p);
        ws.send(JSON.stringify({type:"joined",code:ROOM.code}));
        broadcastState(ROOM); return;
      }
      const p=playerOf(ROOM,clientId);
      if(!p) throw Error("Join the lounge first.");

      if(m.type==="setSettings"){
        if(ROOM.hostId!==clientId||ROOM.game) return;
        ROOM.maxPlayers=[6,8].includes(Number(m.maxPlayers))?Number(m.maxPlayers):6;
        ROOM.minCards=Math.max(10,Math.min(30,Number(m.minCards)||10));
        ROOM.maxCards=Math.max(ROOM.minCards,Math.min(30,Number(m.maxCards)||30));
        broadcastState(ROOM); return;
      }
      if(m.type==="ready"){
        p.ready=!p.ready;
        broadcastState(ROOM);
        updateReadyState(ROOM);
        return;
      }
      if(m.type==="resume"){
        const gp=gamePlayer(ROOM,clientId);
        if(gp){ gp.away=false; gp.spectating=false; }
        p.away=false; p.spectating=false;
        broadcastState(ROOM); return;
      }
      if(m.type==="spectate"){
        const gp=gamePlayer(ROOM,clientId);
        if(gp){
          gp.away=true; gp.spectating=true;
          if(ROOM.game && ROOM.game.players[ROOM.game.turn]?.id===clientId) advance(ROOM.game,1);
        }
        p.away=true; p.spectating=true;
        broadcastState(ROOM); return;
      }
      if(m.type==="end"){
        if(ROOM.hostId!==clientId) throw Error("Only the host can end the game.");
        const g=ROOM.game;
        let rankings=g?g.rankings.slice():[];
        if(g){
          const remaining=g.players.filter(p=>!p.finished).sort((a,b)=>a.hand.length-b.hand.length);
          remaining.forEach(p=>rankings.push({id:p.id,username:p.username,rank:rankings.length+1}));
        }
        const winner=g?.winner||(rankings[0]?rankings[0].id:null);
        ROOM.game=null;
        for(const pl of ROOM.players) pl.ready=false;
        cancelCountdown(ROOM);
        broadcast(ROOM,{type:"gameEnded",winner,rankings});
        broadcastState(ROOM); return;
      }
      if(m.type==="kick"){
        if(ROOM.hostId!==clientId) throw Error("Only the host can kick.");
        const t=playerOf(ROOM,m.playerId);
        if(!t) return;
        if(t.id===ROOM.hostId) throw Error("You can't kick the host.");
        removePlayerCompletely(ROOM,t.id);
        if(t.ws){ try{t.ws.send(JSON.stringify({type:"kicked"}));}catch(e){} try{t.ws.close();}catch(e){} }
        finalizeIfDone(ROOM);
        broadcastState(ROOM); return;
      }
      if(m.type==="play"){handlePlay(ROOM,p,m);return;}
      if(m.type==="draw"){handleDraw(ROOM,p);return;}
      if(m.type==="uno"){
        const gp=gamePlayer(ROOM,clientId);
        if(gp && gp.hand.length===1){gp.calledUno=true;broadcast(ROOM,{type:"sound",name:"uno"});broadcastState(ROOM);}
        return;
      }
      if(m.type==="cut"){
        console.log("[CUT] Player",p.username,"pressed CUT");
        const g=ROOM.game;
        if(!g||g.isOver){console.log("[CUT] Game not active");ws.send(JSON.stringify({type:"error",message:"Game is not active."}));return;}
        broadcast(ROOM,{type:"cutPressed",playerId:clientId,username:p.username});
        const target=g.players.find(pl=>!pl.finished&&pl.id!==p.id&&pl.hand.length===1&&!pl.calledUno);
        console.log("[CUT] Target found:",target?target.username:"none","| finished:"+g.players.map(pl=>pl.username+":"+pl.hand.length+"f:"+pl.finished+"u:"+pl.calledUno).join(", "));
        if(target){
          console.log("[CUT] Drawing 4 cards for",target.username,"hand before:",target.hand.length);
          const drawn=drawCards(ROOM,g,target,4);
          console.log("[CUT] Drew",drawn,"cards, hand after:",target.hand.length);
          target.calledUno=false;
          broadcast(ROOM,{type:"sound",name:"draw"});
          broadcast(ROOM,{type:"cutAlert",username:target.username,targetId:target.id,drawn:drawn});
          broadcastState(ROOM);
        } else {
          const candidates=g.players.filter(pl=>!pl.finished&&pl.id!==p.id&&pl.hand.length===1);
          if(candidates.length===0){
            ws.send(JSON.stringify({type:"error",message:"No player has exactly 1 card right now."}));
          }else{
            ws.send(JSON.stringify({type:"error",message:"All players with 1 card already called UNO!"}));
          }
        }
        return;
      }
      if(m.type==="emoji"){
        const gp=gamePlayer(ROOM,clientId);
        if(gp) broadcast(ROOM,{type:"emoji",playerId:clientId,emoji:String(m.emoji||"🙂").slice(0,4)});
      }
      if(m.type==="chat"){
        const text=String(m.text||"").trim().slice(0,200);
        if(!text) return;
        broadcast(ROOM,{type:"chat",playerId:clientId,username:p.username,avatar:p.avatar,text});
        return;
      }
      if(m.type==="chatgif"){
        const url=String(m.url||"").trim().slice(0,500);
        if(!url || !/^https?:\/\/.*giphy\.com\//.test(url)) return;
        const w=Math.max(0,Math.min(500,Number(m.width)||0));
        const h=Math.max(0,Math.min(500,Number(m.height)||0));
        const proxyUrl="/gif-proxy?url="+encodeURIComponent(url);
        broadcast(ROOM,{type:"chatgif",playerId:clientId,username:p.username,avatar:p.avatar,url:proxyUrl,width:w,height:h});
        return;
      }
      if(m.type==="reshuffle"){
        const g=ROOM.game,gp=gamePlayer(ROOM,clientId);
        if(!g||g.isOver||!gp){ws.send(JSON.stringify({type:"error",message:"Game is not active."}));return;}
        if(gp.away||gp.spectating){ws.send(JSON.stringify({type:"error",message:"You can't reshuffle while spectating."}));return;}
        if(g.players[g.turn]?.id!==clientId){ws.send(JSON.stringify({type:"error",message:"It's not your turn."}));return;}
        if(g.reshuffled){ws.send(JSON.stringify({type:"error",message:"You already reshuffled this turn."}));return;}
        // Make sure the deck has at least 3 cards to peek.
        let guard=0;
        while(g.deck.length<3 && guard++<3){
          let src=g.discardPile && g.discardPile.length ? g.discardPile.splice(0) : makeDeck();
          shuffle(src); g.deck=src.concat(g.deck);
        }
        g.reshuffled=true;
        // Peek (don't remove) the top 3 cards and reveal to everyone.
        const cards=g.deck.slice(0,3).map(c=>({type:c.type,color:c.color,value:c.value!==undefined?c.value:null}));
        broadcast(ROOM,{type:"reshuffleReveal",cards,username:gp.username});
        const nowDeck=g.deck;
        setTimeout(()=>{ shuffle(nowDeck); broadcastState(ROOM); },1800);
        return;
      }
      if(m.type==="typing"){
        broadcast(ROOM,{type:"typing",playerId:clientId});
        return;
      }
    }catch(err){
      ws.send(JSON.stringify({type:"error",message:err.message||"Something went wrong."}));
    }
  });

  ws.on("close",()=>{
    const p=playerOf(ROOM,clientId); if(!p) return;
    p.ws=null; p.ready=false;
    if(ROOM.game && !ROOM.game.isOver){
      const gp=gamePlayer(ROOM,clientId);
      if(gp){
        gp.away=true;
        if(ROOM.game.players[ROOM.game.turn]?.id===clientId) advance(ROOM.game,1);
      }
    } else {
      ROOM.players=ROOM.players.filter(x=>x.id!==clientId);
    }
    if(ROOM.hostId===clientId){
      const next=ROOM.players.find(x=>x.ws);
      if(next){
        ROOM.hostId=next.id;
        broadcast(ROOM,{type:"hostChanged",hostId:next.id,username:next.username});
      }
    }
    cancelCountdown(ROOM);
    updateReadyState(ROOM);
    broadcastState(ROOM);
  });
});

function turnTimerTick(){
  const g=ROOM.game;
  if(!g||g.isOver) return;
  // End the game if nobody is actively playing (everyone finished/away).
  if(finalizeIfDone(ROOM)) return;
  const gp=g.players[g.turn];
  if(!gp) return;
  // A player sitting on exactly 2 cards (about to win) gets no countdown and no auto-resolve.
  if(gp.hand.length===2) return;
  const remaining=TURN_MS-(Date.now()-(g.turnStartedAt||Date.now()));
  if(remaining<=0){
    const p=playerOf(ROOM,gp.id);
    if(p&&p.ws&&!p.away){
      const playable=gp.hand.filter(c=>canPlay(g,c));
      if(playable.length){
        const c=playable[0];
        const color=(c.type==="wild"||c.type==="wild4")?COLORS[Math.floor(Math.random()*4)]:c.color;
        handlePlay(ROOM,p,{cardId:c.id,color});
        broadcast(ROOM,{type:"toast",message:p.username+" ran out of time — auto-played a card"});
      }else{
        handleDraw(ROOM,p);
        broadcast(ROOM,{type:"toast",message:p.username+" ran out of time — drew a card"});
      }
    }
    return;
  }
  broadcast(ROOM,{type:"turnTimer",seconds:Math.ceil(remaining/1000),playerId:gp.id});
}
setInterval(turnTimerTick,1000);

server.listen(PORT,"0.0.0.0",()=>{
  console.log(`UNO Lounge running on http://0.0.0.0:${PORT}`);
});
