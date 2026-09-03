
require('dotenv').config();
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const WebSocket = require("ws");
const cfg = require("./config");

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

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const COLORS = ["red","yellow","green","blue"];
const TYPES = ["number","skip","reverse","draw2","wild","wild4"];

function id(){ return crypto.randomBytes(8).toString("hex"); }

// Single shared lounge: no join codes. Everyone who connects lands here.
const ROOM = { code:"LOUNGE", hostId:null, maxPlayers:cfg.MAX_PLAYERS, minCards:10, maxCards:30, players:[], game:null };
let countdownTimer = null;

// ===== TEST BUILD ONLY: auto-playing bots to exercise the turn mechanism =====
const BOT_COUNT = cfg.BOT_COUNT;
const BOT_AVATARS = cfg.BOT_AVATARS;
const TURN_MS = 20000;
function addTestBots(r){
  for(let i=0;i<BOT_COUNT;i++){
    r.players.push({id:id(),username:"Bot"+(i+1),ws:null,avatar:BOT_AVATARS[i%BOT_AVATARS.length],ready:true,bot:true,away:false,spectating:false});
  }
  // host stays unset so the first human to join becomes host (can use Kick etc.)
}
function botTick(){
  const r=ROOM;
  if(!r.game){
    if(r.players.length>=2){ r.players.forEach(p=>p.ready=true); updateReadyState(r); }
    return;
  }
  const g=r.game;
  if(g.isOver) return;
  const gp=g.players[g.turn];
  if(!gp||gp.finished||gp.away||!gp.bot||gp._botTimer) return;
  gp._botTimer=setTimeout(()=>{
    gp._botTimer=null;
    if(!ROOM.game||ROOM.game.isOver) return;
    if(ROOM.game.players[ROOM.game.turn]?.id!==gp.id) return;
    const playable=gp.hand.filter(c=>canPlay(ROOM.game,c));
    if(playable.length){
      const c=playable[0];
      const color=(c.type==="wild"||c.type==="wild4")?COLORS[Math.floor(Math.random()*4)]:c.color;
      handlePlay(ROOM,{id:gp.id},{cardId:c.id,color});
      const bg=gamePlayer(ROOM,gp.id);
      if(bg && bg.hand.length===1){ bg.calledUno=true; broadcast(ROOM,{type:"sound",name:"uno"}); broadcastState(ROOM); }
    }else{
      handleDraw(ROOM,{id:gp.id});
    }
  },3000);
}
function turnTimerTick(){
  const g=ROOM.game;
  if(!g||g.isOver) return;
  const gp=g.players[g.turn];
  if(!gp) return;
  const remaining=TURN_MS-(Date.now()-(g.turnStartedAt||Date.now()));
  if(remaining<=0){
    g.turnStartedAt=Date.now(); // reset so auto-resolve fires once
    const playable=gp.hand.filter(c=>canPlay(g,c));
    if(playable.length){
      const c=playable[0];
      const color=(c.type==="wild"||c.type==="wild4")?COLORS[Math.floor(Math.random()*4)]:c.color;
      handlePlay(ROOM,{id:gp.id},{cardId:c.id,color});
      broadcast(ROOM,{type:"toast",message:gp.username+" timed out — auto-played a card"});
    }else{
      handleDraw(ROOM,{id:gp.id});
      broadcast(ROOM,{type:"toast",message:gp.username+" timed out — drew a card"});
    }
    return;
  }
  broadcast(ROOM,{type:"turnTimer",seconds:Math.max(0,Math.ceil(remaining/1000)),playerId:gp.id});
}
// =============================================================================

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
    players:r.players.map(p=>({id:p.id,username:p.username,avatar:p.avatar,host:p.id===r.hostId,connected:!!p.ws||!!p.bot,ready:!!p.ready,away:!!p.away,spectating:!!p.spectating,bot:!!p.bot}))
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
        calledUno:x.calledUno,        connected:!!r.players.find(q=>q.id===x.id)?.ws||!!r.players.find(q=>q.id===x.id)?.bot,
        finished:!!x.finished,away:!!x.away,spectating:!!x.spectating
      })),
      turn:r.game.turn,discard:r.game.discard,currentColor:r.game.currentColor,
      drawStack:r.game.drawStack,winner:r.game.winner||null,
      hand:(me&&!me.spectating)?me.hand:[],
      rankings:r.game.rankings||[],direction:r.game.direction||1,isOver:!!r.game.isOver
    } : null;
    p.ws.send(JSON.stringify({type:"state",room:base,game}));
  }
}
function playerOf(r,id){ return r.players.find(p=>p.id===id); }
function gamePlayer(r,id){ return r.game?.players.find(p=>p.id===id); }

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
  g.turnStartedAt=Date.now();
}

function startGame(r){
  if(r.players.length<2) throw Error("Need at least 2 players.");
  const deck=shuffle(makeDeck());
  const gps=r.players.map((p,i)=>({id:p.id,username:p.username,avatar:p.avatar,seat:i,hand:[],calledUno:false,finished:false,bot:!!p.bot,away:!!p.away,spectating:!!p.spectating}));
  const g={players:gps,deck,discardPile:[],discard:null,currentColor:null,turn:0,drawStack:0,winner:null,direction:1,rankings:[],isOver:false};
  for(const gp of gps) drawCards(r,g,gp,r.minCards);

  // Start with a non-wild card so the first color is clear.
  while(true){
    const c=g.deck.pop();
    if(c && c.color!=="wild"){ g.discard=c; g.currentColor=c.color; break; }
    if(c) g.discardPile.push(c);
  }
  r.game=g;
  for(const p of r.players) p.ready=false;
  // TEST BUILD: make sure the first turn lands on a real (non-spectator) player
  let guard=g.players.length;
  while(guard-->0 && (g.players[g.turn].away||g.players[g.turn].spectating)) advance(g,1);
  g.turnStartedAt=Date.now();
  broadcast(r,{type:"started"});
  broadcastState(r);
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
    const active=g.players.filter(p=>!p.finished);
    if(active.length<=1){
      if(active.length===1){
        active[0].finished=true;active[0].hand=[];active[0].calledUno=false;
        g.rankings.push({id:active[0].id,username:active[0].username,rank:g.rankings.length+1});
      }
      g.isOver=true;g.winner=g.rankings[0].id;
      broadcast(r,{type:"sound",name:"card"});
      broadcast(r,{type:"gameFinished",rankings:g.rankings});
      r.game=null;
      for(const pl of r.players) pl.ready=false;
      broadcastState(r);
      updateReadyState(r);
      return;
    }
    advance(g,steps);
    broadcast(r,{type:"sound",name:"card"});
    broadcastState(r);return;
  }

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
          // TEST BUILD: mid-game joiners spectate (watch + chat); they play the next round they join from the lobby
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
        const winner=ROOM.game?.winner||null;
        ROOM.game=null;
        for(const pl of ROOM.players) pl.ready=false;
        cancelCountdown(ROOM);
        broadcast(ROOM,{type:"gameEnded",winner});
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
      if(m.type==="kick"){
        if(ROOM.hostId!==clientId) throw Error("Only the host can kick.");
        const tgt=ROOM.players.find(x=>x.id===m.playerId);
        if(!tgt) return;
        if(tgt.id===ROOM.hostId) throw Error("You can't kick the host.");
        ROOM.players=ROOM.players.filter(x=>x.id!==tgt.id);
        if(ROOM.game){
          const gp=gamePlayer(ROOM,tgt.id);
          if(gp){ gp.away=true; gp.spectating=true; if(ROOM.game.players[ROOM.game.turn]?.id===tgt.id) advance(ROOM.game,1); }
        }
        if(tgt.ws){ try{tgt.ws.send(JSON.stringify({type:"kicked"}));}catch(e){} try{tgt.ws.close();}catch(e){} }
        broadcastState(ROOM); return;
      }
    }catch(err){
      ws.send(JSON.stringify({type:"error",message:err.message||"Something went wrong."}));
    }
  });

  ws.on("close",()=>{
    const p=playerOf(ROOM,clientId); if(!p) return;
    p.ws=null; p.ready=false;
    if(ROOM.game && !ROOM.game.isOver){
      // Game active: mark away so the game keeps flowing; keep the seat for reconnect/spectate.
      const gp=gamePlayer(ROOM,clientId);
      if(gp){
        gp.away=true;
        if(ROOM.game.players[ROOM.game.turn]?.id===clientId) advance(ROOM.game,1);
      }
    } else {
      // No active game: remove from the roster so the lobby stays clean.
      ROOM.players=ROOM.players.filter(x=>x.id!==clientId);
    }
    // Transfer host if the leaving player was the host.
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

server.listen(PORT,"0.0.0.0",()=>{
  console.log(`UNO Lounge running on http://0.0.0.0:${PORT}`);
});

// TEST BUILD: spawn bots and drive their turns
if(cfg.TEST_MODE){ addTestBots(ROOM); setInterval(botTick,400); }
setInterval(turnTimerTick,1000);
